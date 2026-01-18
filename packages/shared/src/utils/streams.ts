/**
 * Redis Streams Manager
 * 
 * Provides strict ordering guarantees per shard (match_id, map_id).
 * Uses Redis Streams with Consumer Groups for reliable delivery.
 */

import type { Redis } from 'ioredis';
import type { BaseEvent } from '../types';
import { createLogger } from './logger';

const logger = createLogger('streams', 'info');

// Stream key pattern: events:{match_id}:{map_id}
export const getStreamKey = (matchId: string, mapId: string): string =>
    `events:${matchId}:${mapId}`;

// Consumer group name
export const CONSUMER_GROUP = 'state-consumers';

export interface StreamEntry {
    id: string;
    event: BaseEvent;
}

export interface StreamManager {
    /**
     * Add event to stream (producer side)
     * Returns stream entry ID
     */
    publish(event: BaseEvent): Promise<string>;

    /**
     * Read events from stream (consumer side)
     * Blocks until events available or timeout
     */
    consume(
        matchId: string,
        mapId: string,
        consumerId: string,
        count?: number,
        blockMs?: number
    ): Promise<StreamEntry[]>;

    /**
     * Acknowledge processed events
     */
    ack(matchId: string, mapId: string, ...ids: string[]): Promise<number>;

    /**
     * Get pending (unacked) events
     */
    pending(matchId: string, mapId: string): Promise<number>;

    /**
     * Create consumer group if not exists
     */
    ensureGroup(matchId: string, mapId: string): Promise<void>;

    /**
     * Cleanup streams after match ends
     */
    cleanup(matchId: string, mapId: string, ttlSeconds?: number): Promise<void>;
}

export function createStreamManager(redis: Redis): StreamManager {
    return {
        async publish(event: BaseEvent): Promise<string> {
            const streamKey = getStreamKey(event.match_id, event.map_id);

            // Ensure consumer group exists
            await this.ensureGroup(event.match_id, event.map_id);

            // Add to stream with automatic ID generation (*)
            // MAXLEN ~ 10000 keeps only last 10k events per stream (approximate trim)
            const id = await redis.xadd(
                streamKey,
                'MAXLEN', '~', '10000',
                '*',
                'event', JSON.stringify(event)
            );

            logger.debug('Event published to stream', {
                stream: streamKey,
                id,
                event_id: event.event_id,
            });

            return id as string;
        },

        async consume(
            matchId: string,
            mapId: string,
            consumerId: string,
            count = 10,
            blockMs = 5000
        ): Promise<StreamEntry[]> {
            const streamKey = getStreamKey(matchId, mapId);

            try {
                // XREADGROUP: read new messages for this consumer
                const result = await redis.xreadgroup(
                    'GROUP', CONSUMER_GROUP, consumerId,
                    'COUNT', String(count),
                    'BLOCK', String(blockMs),
                    'STREAMS', streamKey,
                    '>' // Only new messages
                );

                if (!result || result.length === 0) {
                    return [];
                }

                const entries: StreamEntry[] = [];

                // result format: [[streamKey, [[id, [field, value, ...]], ...]]]
                for (const [, messages] of result) {
                    for (const [id, fields] of messages as [string, string[]][]) {
                        // fields is ['event', '{json}']
                        const eventIdx = fields.indexOf('event');
                        if (eventIdx !== -1 && fields[eventIdx + 1]) {
                            entries.push({
                                id,
                                event: JSON.parse(fields[eventIdx + 1]!) as BaseEvent,
                            });
                        }
                    }
                }

                return entries;

            } catch (error) {
                // NOGROUP error: consumer group doesn't exist
                if (String(error).includes('NOGROUP')) {
                    await this.ensureGroup(matchId, mapId);
                    return [];
                }
                throw error;
            }
        },

        async ack(matchId: string, mapId: string, ...ids: string[]): Promise<number> {
            if (ids.length === 0) return 0;

            const streamKey = getStreamKey(matchId, mapId);
            const count = await redis.xack(streamKey, CONSUMER_GROUP, ...ids);

            return count;
        },

        async pending(matchId: string, mapId: string): Promise<number> {
            const streamKey = getStreamKey(matchId, mapId);

            try {
                const info = await redis.xpending(streamKey, CONSUMER_GROUP);
                // info format: [count, minId, maxId, [[consumer, count], ...]]
                return (info as [number, string, string, unknown[]])[0] ?? 0;
            } catch {
                return 0;
            }
        },

        async ensureGroup(matchId: string, mapId: string): Promise<void> {
            const streamKey = getStreamKey(matchId, mapId);

            try {
                // Create group starting from ID 0 (read all existing messages)
                // Use $ to read only new messages
                await redis.xgroup('CREATE', streamKey, CONSUMER_GROUP, '0', 'MKSTREAM');
                logger.debug('Consumer group created', { stream: streamKey });
            } catch (error) {
                // BUSYGROUP: group already exists — OK
                if (!String(error).includes('BUSYGROUP')) {
                    throw error;
                }
            }
        },

        async cleanup(matchId: string, mapId: string, ttlSeconds = 3600): Promise<void> {
            const streamKey = getStreamKey(matchId, mapId);

            // Set TTL on stream (will be deleted after match + 1 hour by default)
            await redis.expire(streamKey, ttlSeconds);

            logger.info('Stream cleanup scheduled', {
                stream: streamKey,
                ttl_seconds: ttlSeconds,
            });
        },
    };
}

/**
 * Stream Consumer Loop
 * 
 * Consumes events from a stream and processes them with the given handler.
 * Provides backpressure and graceful shutdown.
 */
export interface StreamConsumerOptions {
    matchId: string;
    mapId: string;
    consumerId: string;
    batchSize?: number;
    blockMs?: number;
    onEvent: (entry: StreamEntry) => Promise<void>;
    onError?: (error: Error, entry: StreamEntry) => Promise<void>;
}

export async function* createStreamConsumer(
    stream: StreamManager,
    options: StreamConsumerOptions
): AsyncGenerator<{ processed: number; failed: number }> {
    const {
        matchId,
        mapId,
        consumerId,
        batchSize = 10,
        blockMs = 5000,
        onEvent,
        onError,
    } = options;

    let running = true;
    let processed = 0;
    let failed = 0;

    while (running) {
        try {
            const entries = await stream.consume(matchId, mapId, consumerId, batchSize, blockMs);

            for (const entry of entries) {
                try {
                    await onEvent(entry);
                    await stream.ack(matchId, mapId, entry.id);
                    processed++;
                } catch (error) {
                    failed++;
                    if (onError) {
                        await onError(error as Error, entry);
                    } else {
                        logger.error('Event processing failed', {
                            id: entry.id,
                            event_id: entry.event.event_id,
                            error: String(error),
                        });
                    }
                    // Don't ACK failed events — they'll be retried
                }
            }

            yield { processed, failed };

        } catch (error) {
            logger.error('Stream consumer error', { error: String(error) });
            // Backoff on error
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}
