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

    let buffer: BaseEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleFlush = () => {
        if (flushTimer) return;

        flushTimer = setTimeout(async () => {
            flushTimer = null;
            await flush();
        }, config.batch.flushIntervalMs);
    };

    const flush = async () => {
        if (buffer.length === 0) return;

        const events = buffer;
        buffer = [];

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
                    processed_at: new Date().toISOString(),
                    processor_version: 'v1',
                })),
                format: 'JSONEachRow',
            });

            logger.info('Events written to ClickHouse', { count: events.length });
        } catch (error) {
            logger.error('Failed to write to ClickHouse', {
                error: String(error),
                count: events.length,
            });

            // Put events back in buffer for retry
            buffer = [...events, ...buffer];
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
    };
}
