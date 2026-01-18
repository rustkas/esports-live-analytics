/**
 * ClickHouse Event Writer
 * Batches events and writes to ClickHouse
 */

import { createClient } from '@clickhouse/client';
import type { BaseEvent } from '@esports/shared';
import { createLogger } from '@esports/shared';
import { config } from './config';

const logger = createLogger('state-consumer:clickhouse', config.logLevel as 'debug' | 'info');

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
            max_partitions_per_insert_block: 100, // Safety limit
        },
    });

    let buffer: BaseEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleFlush = () => {
        if (flushTimer) return;

        flushTimer = setTimeout(async () => {
            flushTimer = null;
            await flush();
        }, config.batch.flushIntervalMs);
    };

    const MAX_BUFFER_SIZE = 50000; // Drop events if buffer exceeds this (Circuit Breaker fallback)
    let circuitState: 'closed' | 'open' | 'half-open' = 'closed';
    let failureCount = 0;
    let nextRetry = 0;

    const flush = async () => {
        if (buffer.length === 0) return;

        // Circuit Breaker Check
        if (circuitState === 'open') {
            if (Date.now() < nextRetry) {
                // Check overflow
                if (buffer.length > MAX_BUFFER_SIZE) {
                    logger.warn('Buffer overflow during circuit break, dropping oldest events', { count: buffer.length });
                    buffer = buffer.slice(buffer.length - MAX_BUFFER_SIZE);
                }
                return;
            }
            circuitState = 'half-open';
        }

        const batchSize = Math.min(buffer.length, 5000); // Adaptive: take up to 5k
        const events = buffer.slice(0, batchSize);
        // Do not remove from buffer yet until success, or logic:
        // slice -> try -> if success remove from buffer?
        // Current logic was: move to local var, if fail push back.
        // Better: use slice, if success splice original buffer?
        // But original buffer might have grown.
        // Let's stick to "take out", if fail "put back".
        buffer = buffer.slice(batchSize);

        try {
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
                    // Use ts_event millis as version for ReplacingMergeTree
                    version: new Date(event.ts_event).getTime(),
                })),
                format: 'JSONEachRow',
            });

            logger.info('Events written to ClickHouse', { count: events.length });

            if (circuitState === 'half-open') {
                circuitState = 'closed';
                failureCount = 0;
                logger.info('Circuit Breaker Closed (Recovered)');
            }
        } catch (error) {
            failureCount++;

            logger.error('Failed to write to ClickHouse', {
                error: String(error),
                count: events.length,
                failures: failureCount
            });

            // Circuit Breaker Trip
            if (failureCount > 5 && circuitState !== 'open') {
                circuitState = 'open';
                nextRetry = Date.now() + 10000; // 10s cooldown
                logger.warn('Circuit Breaker Tripped: ClickHouse writes paused');
            }

            // Put events back at HEAD of buffer (FILO? No, we want FIFO order usually, implies unshift)
            // Original code: buffer = [...events, ...buffer];
            buffer.unshift(...events);
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
            await this.flush();
            await client.close();
        },

        async isHealthy(): Promise<boolean> {
            try {
                await client.query({
                    query: 'SELECT 1',
                    format: 'JSONEachRow',
                });
                return true;
            } catch {
                return false;
            }
        },
    };
}
