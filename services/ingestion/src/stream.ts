/**
 * Stream Publisher
 * 
 * Publishes events to Redis Streams with ordering guarantees.
 * Replaces BullMQ for the ingestion → consumer path.
 */

import type { Redis } from 'ioredis';
import type { BaseEvent } from '@esports/shared';
import { createLogger } from '@esports/shared';
import { config } from './config';

const logger = createLogger('ingestion:stream', config.logLevel as 'debug' | 'info');

// Stream key pattern: events:{match_id}:{map_id}
const getStreamKey = (matchId: string, mapId: string): string =>
    `events:${matchId}:${mapId}`;

// Consumer group name
const CONSUMER_GROUP = 'state-consumers';

export interface StreamPublisher {
    /**
     * Publish event to stream
     * Returns stream entry ID
     */
    publish(event: BaseEvent): Promise<string>;

    /**
     * Get stream info for metrics
     */
    getStreamInfo(matchId: string, mapId: string): Promise<{
        length: number;
        pendingCount: number;
    }>;

    /**
     * Ensure consumer group exists (called on publish)
     */
    ensureGroup(matchId: string, mapId: string): Promise<void>;

    /**
     * Initialize (connect to Redis)
     */
    init(): Promise<void>;

    /**
     * Close connection
     */
    close(): Promise<void>;
}

export function createStreamPublisher(redis: Redis): StreamPublisher {
    const groupCreated = new Set<string>();

    return {
        async init(): Promise<void> {
            // No special initialization needed
            logger.info('Stream publisher initialized');
        },

        async publish(event: BaseEvent): Promise<string> {
            const streamKey = getStreamKey(event.match_id, event.map_id);

            // Ensure consumer group exists (cached to avoid repeated calls)
            if (!groupCreated.has(streamKey)) {
                await this.ensureGroup(event.match_id, event.map_id);
                groupCreated.add(streamKey);
            }

            // Add to stream with automatic ID generation (*)
            // MAXLEN ~ 50000 keeps only last 50k events per stream (approximate trim)
            const id = await redis.xadd(
                streamKey,
                'MAXLEN', '~', '50000',
                '*',
                'data', JSON.stringify(event),
                'type', event.type,
                'event_id', event.event_id
            );

            logger.debug('Event published to stream', {
                stream: streamKey,
                id,
                event_id: event.event_id,
                type: event.type,
            });

            return id as string;
        },

        async getStreamInfo(matchId: string, mapId: string) {
            const streamKey = getStreamKey(matchId, mapId);

            try {
                const length = await redis.xlen(streamKey);

                let pendingCount = 0;
                try {
                    const pending = await redis.xpending(streamKey, CONSUMER_GROUP);
                    pendingCount = (pending as [number, ...unknown[]])[0] ?? 0;
                } catch {
                    // Group might not exist
                }

                return { length, pendingCount };
            } catch {
                return { length: 0, pendingCount: 0 };
            }
        },

        async ensureGroup(matchId: string, mapId: string): Promise<void> {
            const streamKey = getStreamKey(matchId, mapId);

            try {
                // Create group starting from ID 0 (process all messages)
                // MKSTREAM creates the stream if it doesn't exist
                await redis.xgroup('CREATE', streamKey, CONSUMER_GROUP, '0', 'MKSTREAM');
                logger.debug('Consumer group created', { stream: streamKey });
            } catch (error) {
                // BUSYGROUP: group already exists — OK
                if (!String(error).includes('BUSYGROUP')) {
                    throw error;
                }
            }
        },

        async close(): Promise<void> {
            logger.info('Stream publisher closed');
        },
    };
}

/**
 * Get all active streams (for monitoring)
 */
export async function getActiveStreams(redis: Redis, pattern = 'events:*'): Promise<string[]> {
    const keys = await redis.keys(pattern);
    return keys;
}
