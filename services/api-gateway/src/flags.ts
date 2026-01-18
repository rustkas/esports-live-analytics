import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { createLogger } from '@esports/shared';

const logger = createLogger('api-gateway:flags');

export interface FeatureFlag {
    name: string;
    isEnabled: boolean;
    value?: any;
}

export function createFeatureFlagService(redis: Redis, db: Pool) {
    const CACHE_TTL = 60; // 1 minute

    async function getFlag(name: string, clientId?: string): Promise<boolean> {
        const cacheKey = `flags:${name}:${clientId ?? 'global'}`;

        // 1. Check Cache
        const cached = await redis.get(cacheKey);
        if (cached !== null) {
            return cached === '1';
        }

        // 2. Check DB
        try {
            // Check specific client flag first, then global
            const query = `
                SELECT is_enabled 
                FROM feature_flags 
                WHERE name = $1 
                  AND (client_id = $2 OR client_id IS NULL)
                ORDER BY client_id NULLS LAST 
                LIMIT 1
            `;
            const result = await db.query(query, [name, clientId]);

            const isEnabled = result.rows.length > 0 ? result.rows[0].is_enabled : false; // Default false if not found? Or true? Default false usually.

            // Cache
            await redis.set(cacheKey, isEnabled ? '1' : '0', 'EX', CACHE_TTL);
            return isEnabled;
        } catch (err) {
            logger.error('Failed to fetch flag', { name, error: String(err) });
            return false; // Fail safe
        }
    }

    return { getFlag };
}

export type FeatureFlagService = ReturnType<typeof createFeatureFlagService>;
