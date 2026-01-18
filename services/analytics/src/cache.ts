/**
 * Caching Query Service
 * 
 * Wraps QueryService with Redis caching and invalidation logic.
 */

import type { Redis } from 'ioredis';
import type { QueryService } from './queries';
import { REDIS_KEYS, createLogger } from '@esports/shared';

const logger = createLogger('analytics:cache');
const TTL_SECONDS = 30;

export function createCachedQueryService(
    service: QueryService,
    redis: Redis,
    ttl = TTL_SECONDS
): QueryService {
    // Separate connection for subscription
    const sub = redis.duplicate();

    // Subscribe to all match updates to invalidate cache
    // Note: match-updates:* pattern matches match-updates:uuid
    // The channel is defined in REDIS_KEYS.matchUpdates(matchId) which is match-updates:{matchId}
    sub.psubscribe('match-updates:*');

    sub.on('pmessage', async (_pattern, channel, _message) => {
        // Extract matchId from channel "match-updates:{matchId}"
        const matchId = channel.split(':')[1];
        if (matchId) {
            await invalidateMatchCache(matchId);
        }
    });

    async function invalidateMatchCache(matchId: string) {
        const setKey = `analytics:keys:${matchId}`;
        const keys = await redis.smembers(setKey);

        if (keys.length > 0) {
            // Delete all cached keys
            await redis.del(...keys);
            // Delete the set itself
            await redis.del(setKey);
            logger.debug('Invalidated cache for match', { matchId, count: keys.length });
        }
    }

    async function remember<T>(
        key: string,
        matchId: string,
        fetcher: () => Promise<T>
    ): Promise<T> {
        // Try cache
        const cached = await redis.get(key);
        if (cached) {
            return JSON.parse(cached) as T;
        }

        // Fetch
        const data = await fetcher();

        if (data) {
            // Store in cache
            await redis.set(key, JSON.stringify(data), 'EX', ttl);
            // Track key for invalidation
            await redis.sadd(`analytics:keys:${matchId}`, key);
            // Expire the tracking set eventually (e.g. 1 hour)
            await redis.expire(`analytics:keys:${matchId}`, 3600);
        }

        return data;
    }

    return {
        async getRoundMetrics(matchId: string, mapId: string) {
            return remember(
                `analytics:start:round-metrics:${matchId}:${mapId}`,
                matchId,
                () => service.getRoundMetrics(matchId, mapId)
            );
        },

        async getMatchMetrics(matchId: string) {
            return remember(
                `analytics:match-metrics:${matchId}`,
                matchId,
                () => service.getMatchMetrics(matchId)
            );
        },

        async getPredictionHistory(matchId: string, mapId: string) {
            return remember(
                `analytics:pred-history:${matchId}:${mapId}`,
                matchId,
                () => service.getPredictionHistory(matchId, mapId)
            );
        },

        async getEventCounts(matchId: string) {
            return remember(
                `analytics:event-counts:${matchId}`,
                matchId,
                () => service.getEventCounts(matchId)
            );
        },

        async getPlayerStats(matchId: string, mapId: string) {
            return remember(
                `analytics:player-stats:${matchId}:${mapId}`,
                matchId,
                () => service.getPlayerStats(matchId, mapId)
            );
        },

        async healthCheck() {
            return service.healthCheck();
        },

        async close() {
            sub.disconnect();
            await service.close();
        }
    };
}
