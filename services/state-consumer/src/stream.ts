/**
 * Stream Consumer
 * 
 * Consumes events from Redis Streams with strict ordering.
 * Supports multiple concurrent streams (one per match/map shard).
 */

import type { Redis } from 'ioredis';
import type { BaseEvent } from '@esports/shared';
import { createLogger } from '@esports/shared';
import { config } from './config';

const logger = createLogger('state-consumer:stream', config.logLevel as 'debug' | 'info');

// Consumer group name (must match ingestion service)
const CONSUMER_GROUP = 'state-consumers';

export interface StreamEntry {
    id: string;
    streamKey: string;
    event: BaseEvent;
}

export interface StreamConsumer {
    consume(
        streamKeys: string[],
        consumerId: string,
        count?: number,
        blockMs?: number
    ): Promise<StreamEntry[]>;

    ack(streamKey: string, ...ids: string[]): Promise<number>;

    pending(streamKey: string): Promise<number>;

    discoverStreams(pattern?: string): Promise<string[]>;

    claimStale(
        streamKey: string,
        consumerId: string,
        minIdleMs?: number,
        count?: number
    ): Promise<StreamEntry[]>;
}

type XReadGroupResult = [string, [string, string[]][]][] | null;

export function createStreamConsumer(redis: Redis): StreamConsumer {
    return {
        async consume(
            streamKeys: string[],
            consumerId: string,
            count = 10,
            blockMs = 2000
        ): Promise<StreamEntry[]> {
            if (streamKeys.length === 0) {
                return [];
            }

            try {
                // Build args for XREADGROUP
                const streamArgs = streamKeys.flatMap(key => [key]);
                const idArgs = streamKeys.map(() => '>');

                const result = await redis.xreadgroup(
                    'GROUP',
                    CONSUMER_GROUP,
                    consumerId,
                    'COUNT',
                    count,
                    'BLOCK',
                    blockMs,
                    'STREAMS',
                    ...streamArgs,
                    ...idArgs
                ) as XReadGroupResult;

                if (!result || result.length === 0) {
                    return [];
                }

                const entries: StreamEntry[] = [];

                for (const streamData of result) {
                    const streamKey = streamData[0];
                    const messages = streamData[1];

                    for (const message of messages) {
                        const id = message[0];
                        const fields = message[1];

                        // fields is ['data', '{json}', 'type', 'kill', ...]
                        const dataIdx = fields.indexOf('data');
                        if (dataIdx !== -1 && fields[dataIdx + 1]) {
                            try {
                                entries.push({
                                    id,
                                    streamKey,
                                    event: JSON.parse(fields[dataIdx + 1]!) as BaseEvent,
                                });
                            } catch (e) {
                                logger.error('Failed to parse event', { id, error: String(e) });
                            }
                        }
                    }
                }

                return entries;

            } catch (error) {
                // NOGROUP error: consumer group doesn't exist
                if (String(error).includes('NOGROUP')) {
                    logger.warn('Consumer group does not exist, waiting...', { streamKeys });
                    return [];
                }
                throw error;
            }
        },

        async ack(streamKey: string, ...ids: string[]): Promise<number> {
            if (ids.length === 0) return 0;

            const count = await redis.xack(streamKey, CONSUMER_GROUP, ...ids);
            return count;
        },

        async pending(streamKey: string): Promise<number> {
            try {
                const info = await redis.xpending(streamKey, CONSUMER_GROUP);
                return (info as [number, ...unknown[]])[0] ?? 0;
            } catch {
                return 0;
            }
        },

        async discoverStreams(pattern = 'events:*'): Promise<string[]> {
            const keys = await redis.keys(pattern);
            return keys.sort();
        },

        async claimStale(
            streamKey: string,
            consumerId: string,
            minIdleMs = 60000,
            count = 10
        ): Promise<StreamEntry[]> {
            try {
                const result = await redis.xautoclaim(
                    streamKey,
                    CONSUMER_GROUP,
                    consumerId,
                    minIdleMs,
                    '0-0',
                    'COUNT',
                    count
                ) as [string, [string, string[]][], string[]];

                if (!result || result.length < 2) {
                    return [];
                }

                const entries: StreamEntry[] = [];
                const messages = result[1];

                for (const message of messages) {
                    const id = message[0];
                    const fields = message[1];

                    const dataIdx = fields.indexOf('data');
                    if (dataIdx !== -1 && fields[dataIdx + 1]) {
                        try {
                            entries.push({
                                id,
                                streamKey,
                                event: JSON.parse(fields[dataIdx + 1]!) as BaseEvent,
                            });
                        } catch (e) {
                            logger.error('Failed to parse claimed event', { id, error: String(e) });
                        }
                    }
                }

                if (entries.length > 0) {
                    logger.info('Claimed stale messages', {
                        stream: streamKey,
                        count: entries.length,
                    });
                }

                return entries;

            } catch (error) {
                logger.error('Failed to claim stale messages', {
                    stream: streamKey,
                    error: String(error),
                });
                return [];
            }
        },
    };
}

/**
 * Stream Consumer Loop
 */
export interface ConsumerLoopOptions {
    consumerId: string;
    onEvent: (entry: StreamEntry) => Promise<void>;
    onError?: (error: Error, entry: StreamEntry) => Promise<void>;
    batchSize?: number;
    blockMs?: number;
    discoveryIntervalMs?: number;
}

export async function runConsumerLoop(
    consumer: StreamConsumer,
    options: ConsumerLoopOptions,
    signal: { stop: boolean }
): Promise<void> {
    const {
        consumerId,
        onEvent,
        onError,
        batchSize = 10,
        blockMs = 2000,
        discoveryIntervalMs = 5000,
    } = options;

    let knownStreams: string[] = [];
    let lastDiscovery = 0;

    logger.info('Starting consumer loop', { consumerId, batchSize, blockMs });

    while (!signal.stop) {
        try {
            const now = Date.now();
            if (now - lastDiscovery > discoveryIntervalMs) {
                knownStreams = await consumer.discoverStreams();
                lastDiscovery = now;

                if (knownStreams.length > 0) {
                    logger.debug('Discovered streams', { count: knownStreams.length });
                }
            }

            if (knownStreams.length === 0) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }

            const entries = await consumer.consume(knownStreams, consumerId, batchSize, blockMs);

            for (const entry of entries) {
                try {
                    await onEvent(entry);
                    await consumer.ack(entry.streamKey, entry.id);
                } catch (error) {
                    if (onError) {
                        await onError(error as Error, entry);
                    } else {
                        logger.error('Event processing failed', {
                            id: entry.id,
                            event_id: entry.event.event_id,
                            error: String(error),
                        });
                    }
                }
            }

        } catch (error) {
            logger.error('Consumer loop error', { error: String(error) });
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    logger.info('Consumer loop stopped', { consumerId });
}
