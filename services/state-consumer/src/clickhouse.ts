/**
 * ClickHouse Event Writer
 * Batches events and writes to ClickHouse with Circuit Breaker and Spooling.
 */

import { createClient } from '@clickhouse/client';
import type { BaseEvent } from '@esports/shared';
import { createLogger, createProductionMetrics } from '@esports/shared';
import { LocalDiskSpool } from './spool';
import { config } from './config';

const logger = createLogger('state-consumer:clickhouse', config.logLevel as 'debug' | 'info');
const metrics = createProductionMetrics('clickhouse_writer');

// Metric: Backlog size (in-memory buffer)
const backlogGauge = metrics.registry.createGauge('ch_write_backlog', 'Events waiting to be written');

export interface ClickHouseWriter {
    write(event: BaseEvent): void;
    flush(): Promise<void>;
    close(): Promise<void>;
    isHealthy(): Promise<boolean>;
}

export function createClickHouseWriter(): ClickHouseWriter {
    const client = createClient({
        host: config.clickhouse.url,
        database: config.clickhouse.database,
        clickhouse_settings: {
            async_insert: 1,
            wait_for_async_insert: 0,
        },
    });

    const spool = new LocalDiskSpool();
    let buffer: BaseEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    // Configuration
    const MAX_BUFFER_SIZE = 50000;
    const SPOOL_THRESHOLD = 2000; // If circuit open/failing, spool chunks of 2k
    const BATCH_SIZE = 5000;

    let circuitState: 'closed' | 'open' | 'half-open' = 'closed';
    let failureCount = 0;
    let nextRetry = 0;
    let isRecovering = false;

    const scheduleFlush = () => {
        if (flushTimer) return;
        flushTimer = setTimeout(async () => {
            flushTimer = null;
            await flush();
        }, config.batch.flushIntervalMs);
    };

    // Background recovery process (triggered when Healthy)
    const tryRecover = async () => {
        if (isRecovering || circuitState === 'open') return;
        isRecovering = true;

        try {
            // Read one batch at a time to not overload RAM
            for await (const batch of spool.readBatches()) {
                if (circuitState === 'open') break;

                logger.info('Recovering spooled batch', { file: batch.file, count: batch.events.length });

                try {
                    await insertToCH(batch.events);
                    await spool.delete(batch.file);
                } catch (e) {
                    logger.warn('Recovery failed for batch, retrying later', { file: batch.file });
                    // If recovery fails, we assume CH is down again or bad data
                    // Wait briefly
                    await new Promise(r => setTimeout(r, 2000));
                    break;
                }
            }
        } catch (e) {
            logger.error('Recovery process error', { error: String(e) });
        } finally {
            isRecovering = false;
        }
    };

    const insertToCH = async (events: BaseEvent[]) => {
        await client.insert({
            table: 'cs2_events_raw',
            values: events.map(event => ({
                date: event.ts_event.split('T')[0],
                ts_event: event.ts_event,
                ts_ingest: event.ts_ingest ?? new Date().toISOString(),
                event_id: event.event_id,
                source: event.source,
                seq_no: event.seq_no,
                match_id: event.match_id,
                map_id: event.map_id,
                round_no: event.round_no,
                type: event.type,
                payload: JSON.stringify(event.payload),
                trace_id: event.context?.trace_id || '',
                version: new Date(event.ts_event).getTime(),
            })),
            format: 'JSONEachRow',
        });
    };

    const flush = async () => {
        backlogGauge.set(buffer.length);
        if (buffer.length === 0) {
            if (circuitState === 'closed') tryRecover();
            return;
        }

        // Circuit Breaker Logic
        if (circuitState === 'open') {
            if (Date.now() < nextRetry) {
                // Spool immediately if growing too large
                if (buffer.length > SPOOL_THRESHOLD) {
                    const chunk = buffer;
                    buffer = [];
                    backlogGauge.set(0);
                    await spool.write(chunk); // Async write to disk
                }
                return;
            }
            circuitState = 'half-open';
            logger.info('Circuit Breaker entering Half-Open state');
        }

        // Prepare batch
        const batchSize = Math.min(buffer.length, BATCH_SIZE);
        const events = buffer.slice(0, batchSize);
        // Optimistic removal (copy-on-write style)
        buffer = buffer.slice(batchSize);

        try {
            await insertToCH(events);

            if (circuitState === 'half-open') {
                circuitState = 'closed';
                failureCount = 0;
                logger.info('Circuit Breaker Closed (Recovered)');
                tryRecover();
            }

            logger.debug('Flushed to ClickHouse', { count: events.length });

        } catch (error) {
            failureCount++;
            logger.error('Flush failed', { error: String(error), count: events.length, attempt: failureCount });

            // Trip Circuit
            if (failureCount > 3) {
                circuitState = 'open';
                nextRetry = Date.now() + 10000; // 10s backoff
                logger.warn('Circuit Breaker Tripped: Switching to Spool Mode');
            }

            // Fallback: Spool failed events to disk
            // Do NOT put back in memory buffer to avoid blockage/OOM
            const stored = await spool.write(events);
            if (!stored) {
                // Critical failure: Disk and Network down?
                // Re-add to buffer as last resort, check overflow
                if (buffer.length + events.length < MAX_BUFFER_SIZE) {
                    buffer.unshift(...events);
                } else {
                    logger.error('CRITICAL: Dropping events (Buffer Full + Disk Spool Failed)', { count: events.length });
                    metrics.errors.inc({ type: 'data_loss' });
                }
            }
        }
    };

    return {
        write(event: BaseEvent): void {
            buffer.push(event);
            if (buffer.length >= config.batch.size) {
                flush();
            } else {
                scheduleFlush();
            }
        },

        async flush(): Promise<void> {
            if (flushTimer) {
                clearTimeout(flushTimer);
                flushTimer = null;
            }
            await flush();
        },

        async close(): Promise<void> {
            await this.flush(); // Try one last mem flush
            await client.close();
        },

        async isHealthy(): Promise<boolean> {
            return circuitState === 'closed';
        },
    };
}
