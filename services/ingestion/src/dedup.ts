/**
 * Event Deduplication
 * Uses Redis to track seen event IDs with TTL
 */

import type { Redis } from 'ioredis';
import { REDIS_KEYS, createLogger } from '@esports/shared';
import { config } from './config';

const logger = createLogger('ingestion:dedup', config.logLevel as 'debug' | 'info');

export interface DedupService {
    isDuplicate(eventId: string): Promise<boolean>;
    markSeen(eventId: string): Promise<void>;
}

export function createDedupService(redis: Redis): DedupService {
    const ttl = config.dedup.ttlSeconds;

    return {
        async isDuplicate(eventId: string): Promise<boolean> {
            if (!config.dedup.enabled) {
                return false;
            }

            const key = REDIS_KEYS.eventSeen(eventId);
            const exists = await redis.exists(key);

            if (exists) {
                logger.debug('Duplicate event detected', { event_id: eventId });
            }

            return exists > 0;
        },

        async markSeen(eventId: string): Promise<void> {
            if (!config.dedup.enabled) {
                return;
            }

            const key = REDIS_KEYS.eventSeen(eventId);
            await redis.set(key, '1', 'EX', ttl);
        },
    };
}
