/**
 * Event Deduplication (Enhanced)
 * 
 * Features:
 * - Configurable TTL
 * - Per-match bounded sets (memory protection)
 * - Redis SET with automatic cleanup
 */

import type { Redis } from 'ioredis';
import { createLogger } from '@esports/shared';

const logger = createLogger('dedup');

export interface DedupConfig {
    /** TTL for dedup keys in seconds */
    ttlSeconds: number;

    /** Use per-match sets instead of individual keys */
    useMatchSets: boolean;

    /** Max events per match set (memory protection) */
    maxEventsPerMatch: number;

    /** Match set TTL in seconds (should cover match duration + buffer) */
    matchSetTtlSeconds: number;
}

export interface DedupService {
    /**
     * Check if event is a duplicate
     */
    isDuplicate(eventId: string, matchId?: string): Promise<boolean>;

    /**
     * Mark event as seen
     */
    markSeen(eventId: string, matchId?: string): Promise<void>;

    /**
     * Get dedup stats for a match
     */
    getMatchStats(matchId: string): Promise<{
        eventCount: number;
        ttl: number;
    }>;

    /**
     * Cleanup expired match sets
     */
    cleanup(): Promise<number>;

    /**
     * Get current config
     */
    getConfig(): DedupConfig;

    /**
     * Update config at runtime
     */
    updateConfig(updates: Partial<DedupConfig>): void;
}

export function createDedupService(redis: Redis, initialConfig: DedupConfig): DedupService {
    let config = { ...initialConfig };

    const keyPrefix = 'event:seen:';
    const matchSetPrefix = 'match:events:';

    const getEventKey = (eventId: string) => `${keyPrefix}${eventId}`;
    const getMatchSetKey = (matchId: string) => `${matchSetPrefix}${matchId}`;

    return {
        async isDuplicate(eventId: string, matchId?: string): Promise<boolean> {
            // Per-match set mode
            if (config.useMatchSets && matchId) {
                const setKey = getMatchSetKey(matchId);
                const isMember = await redis.sismember(setKey, eventId);

                if (isMember) {
                    logger.debug('Duplicate detected (match set)', { event_id: eventId, match_id: matchId });
                }

                return isMember === 1;
            }

            // Individual key mode
            const key = getEventKey(eventId);
            const exists = await redis.exists(key);

            if (exists) {
                logger.debug('Duplicate detected', { event_id: eventId });
            }

            return exists > 0;
        },

        async markSeen(eventId: string, matchId?: string): Promise<void> {
            // Per-match set mode
            if (config.useMatchSets && matchId) {
                const setKey = getMatchSetKey(matchId);
                const pipeline = redis.pipeline();

                // Add to set
                pipeline.sadd(setKey, eventId);

                // Set TTL (only if not already set)
                pipeline.expire(setKey, config.matchSetTtlSeconds, 'NX');

                await pipeline.exec();

                // Check set size and trim if needed (memory protection)
                const size = await redis.scard(setKey);
                if (size > config.maxEventsPerMatch) {
                    logger.warn('Match set exceeds limit, triggering cleanup', {
                        match_id: matchId,
                        size,
                        limit: config.maxEventsPerMatch,
                    });

                    // Get random members to remove (oldest would be ideal but Redis doesn't support)
                    const toRemove = size - config.maxEventsPerMatch;
                    const members = await redis.srandmember(setKey, toRemove);

                    if (members && members.length > 0) {
                        await redis.srem(setKey, ...members);
                    }
                }

                return;
            }

            // Individual key mode
            const key = getEventKey(eventId);
            await redis.set(key, '1', 'EX', config.ttlSeconds);
        },

        async getMatchStats(matchId: string): Promise<{ eventCount: number; ttl: number }> {
            const setKey = getMatchSetKey(matchId);

            const [eventCount, ttl] = await Promise.all([
                redis.scard(setKey),
                redis.ttl(setKey),
            ]);

            return { eventCount, ttl };
        },

        async cleanup(): Promise<number> {
            // Redis handles TTL automatically, but we can scan for orphaned sets
            const cursor = '0';
            let totalCleaned = 0;

            const scan = async (cur: string): Promise<void> => {
                const [nextCursor, keys] = await redis.scan(cur, 'MATCH', `${matchSetPrefix}*`, 'COUNT', 100);

                for (const key of keys) {
                    const ttl = await redis.ttl(key);
                    if (ttl === -1) {
                        // No TTL set - set a default one
                        await redis.expire(key, config.matchSetTtlSeconds);
                        totalCleaned++;
                    }
                }

                if (nextCursor !== '0') {
                    await scan(nextCursor);
                }
            };

            await scan(cursor);

            if (totalCleaned > 0) {
                logger.info('Cleaned orphaned match sets', { count: totalCleaned });
            }

            return totalCleaned;
        },

        getConfig(): DedupConfig {
            return { ...config };
        },

        updateConfig(updates: Partial<DedupConfig>): void {
            config = { ...config, ...updates };
            logger.info('Dedup config updated', config);
        },
    };
}

export const DEFAULT_DEDUP_CONFIG: DedupConfig = {
    ttlSeconds: 3600,           // 1 hour for individual keys
    useMatchSets: true,         // Use per-match sets
    maxEventsPerMatch: 50000,   // Max events per match (memory protection)
    matchSetTtlSeconds: 7200,   // 2 hours (match duration + buffer)
};
