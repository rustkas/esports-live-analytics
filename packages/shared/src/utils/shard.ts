/**
 * Shard Manager
 * 
 * Manages event routing to shards for strict ordering.
 * Uses CRC32 hash for consistent sharding.
 * 
 * Key features:
 * - Per-shard concurrency = 1
 * - Consistent routing via crc32(match_id + map_id)
 * - Bounded sets per match for memory protection
 */

import type { Redis } from 'ioredis';
import { createLogger } from '@esports/shared';

const logger = createLogger('shard');

// CRC32 lookup table
const CRC32_TABLE = (() => {
    const table: number[] = [];
    for (let i = 0; i < 256; i++) {
        let crc = i;
        for (let j = 0; j < 8; j++) {
            crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
        }
        table[i] = crc >>> 0;
    }
    return table;
})();

/**
 * Calculate CRC32 hash of a string
 */
export function crc32(str: string): number {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < str.length; i++) {
        crc = CRC32_TABLE[(crc ^ str.charCodeAt(i)) & 0xFF]! ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Calculate shard key for an event
 */
export function getShardKey(matchId: string, mapId: string, numShards = 16): string {
    const hash = crc32(`${matchId}:${mapId}`);
    const shardNum = hash % numShards;
    return `${matchId}:${mapId}`;  // Use exact match:map for Redis Streams
}

/**
 * Get shard number for routing
 */
export function getShardNumber(matchId: string, mapId: string, numShards = 16): number {
    return crc32(`${matchId}:${mapId}`) % numShards;
}

export interface ShardConfig {
    numShards: number;
    lockTtlMs: number;
    maxEventsPerMatch: number;
}

export interface ShardManager {
    /**
     * Get stream key for a shard
     */
    getStreamKey(matchId: string, mapId: string): string;

    /**
     * Acquire lock for a shard (ensures concurrency = 1)
     */
    acquireLock(shard: string, consumerId: string): Promise<boolean>;

    /**
     * Release shard lock
     */
    releaseLock(shard: string, consumerId: string): Promise<boolean>;

    /**
     * Extend lock TTL (heartbeat)
     */
    extendLock(shard: string, consumerId: string): Promise<boolean>;

    /**
     * Get all active shards
     */
    getActiveShards(): Promise<string[]>;

    /**
     * Get lock holder for a shard
     */
    getLockHolder(shard: string): Promise<string | null>;

    /**
     * Check if shard is locked
     */
    isLocked(shard: string): Promise<boolean>;
}

export function createShardManager(redis: Redis, config: ShardConfig): ShardManager {
    const lockPrefix = 'shard:lock:';
    const streamPrefix = 'events:';

    const getLockKey = (shard: string) => `${lockPrefix}${shard}`;

    return {
        getStreamKey(matchId: string, mapId: string): string {
            return `${streamPrefix}${matchId}:${mapId}`;
        },

        async acquireLock(shard: string, consumerId: string): Promise<boolean> {
            const lockKey = getLockKey(shard);

            // Use SET NX PX for atomic lock acquisition
            const result = await redis.set(
                lockKey,
                consumerId,
                'PX', config.lockTtlMs,
                'NX'
            );

            const acquired = result === 'OK';

            if (acquired) {
                logger.debug('Shard lock acquired', { shard, consumer: consumerId });
            }

            return acquired;
        },

        async releaseLock(shard: string, consumerId: string): Promise<boolean> {
            const lockKey = getLockKey(shard);

            // Only release if we own the lock (Lua script for atomicity)
            const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;

            const result = await redis.eval(script, 1, lockKey, consumerId);
            const released = result === 1;

            if (released) {
                logger.debug('Shard lock released', { shard, consumer: consumerId });
            }

            return released;
        },

        async extendLock(shard: string, consumerId: string): Promise<boolean> {
            const lockKey = getLockKey(shard);

            // Only extend if we own the lock
            const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("pexpire", KEYS[1], ARGV[2])
        else
          return 0
        end
      `;

            const result = await redis.eval(script, 1, lockKey, consumerId, config.lockTtlMs);
            return result === 1;
        },

        async getActiveShards(): Promise<string[]> {
            const keys = await redis.keys(`${streamPrefix}*`);
            return keys.map(key => key.replace(streamPrefix, '')).sort();
        },

        async getLockHolder(shard: string): Promise<string | null> {
            const lockKey = getLockKey(shard);
            return redis.get(lockKey);
        },

        async isLocked(shard: string): Promise<boolean> {
            const holder = await this.getLockHolder(shard);
            return holder !== null;
        },
    };
}

export const DEFAULT_SHARD_CONFIG: ShardConfig = {
    numShards: 16,
    lockTtlMs: 30000, // 30 seconds
    maxEventsPerMatch: 50000,
};
