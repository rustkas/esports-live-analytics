/**
 * Dead Letter Queue (DLQ) Manager
 * 
 * Handles failed events with retry policy:
 * - N retries before moving to DLQ
 * - Admin endpoint for manual requeue
 * - Per-shard DLQ streams
 */

import type { Redis } from 'ioredis';
import type { BaseEvent } from '@esports/shared';
import { createLogger } from '@esports/shared';

const logger = createLogger('dlq');

export interface DLQConfig {
    maxRetries: number;
    retryDelayMs: number;
    dlqStreamPrefix: string;
    dlqMaxLen: number;
}

export interface DLQEntry {
    id: string;
    event: BaseEvent;
    error: string;
    retryCount: number;
    firstFailedAt: string;
    lastFailedAt: string;
    shard: string;
}

export interface DLQManager {
    /**
     * Record a failed event attempt
     * Returns true if moved to DLQ, false if should retry
     */
    recordFailure(event: BaseEvent, shard: string, error: string): Promise<boolean>;

    /**
     * Get retry count for an event
     */
    getRetryCount(eventId: string): Promise<number>;

    /**
     * Move event directly to DLQ
     */
    sendToDLQ(event: BaseEvent, shard: string, error: string): Promise<string>;

    /**
     * Get DLQ entries for a shard
     */
    getDLQEntries(shard: string, count?: number): Promise<DLQEntry[]>;

    /**
     * Get all DLQ shards
     */
    getDLQShards(): Promise<string[]>;

    /**
     * Requeue a single event from DLQ
     */
    requeueEvent(shard: string, dlqEntryId: string): Promise<boolean>;

    /**
     * Requeue all events from a shard's DLQ
     */
    requeueAll(shard: string): Promise<number>;

    /**
     * Get DLQ stats
     */
    getStats(): Promise<{
        totalEntries: number;
        byShardCounts: Record<string, number>;
    }>;

    /**
     * Clear retry count after successful processing
     */
    clearRetryCount(eventId: string): Promise<void>;
}

export function createDLQManager(redis: Redis, config: DLQConfig): DLQManager {
    const retryKeyPrefix = 'dlq:retry:';
    const dlqStreamPrefix = config.dlqStreamPrefix || 'dlq:events:';

    const getDLQStreamKey = (shard: string) => `${dlqStreamPrefix}${shard}`;
    const getRetryKey = (eventId: string) => `${retryKeyPrefix}${eventId}`;

    return {
        async recordFailure(event: BaseEvent, shard: string, error: string): Promise<boolean> {
            const retryKey = getRetryKey(event.event_id);

            // Increment retry count
            const retryCount = await redis.incr(retryKey);

            // Set TTL on first failure (1 hour)
            if (retryCount === 1) {
                await redis.expire(retryKey, 3600);
            }

            logger.warn('Event processing failed', {
                event_id: event.event_id,
                match_id: event.match_id,
                retry_count: retryCount,
                max_retries: config.maxRetries,
                error,
            });

            // If exceeded max retries, move to DLQ
            if (retryCount >= config.maxRetries) {
                await this.sendToDLQ(event, shard, error);
                await redis.del(retryKey);
                return true; // Moved to DLQ
            }

            return false; // Should retry
        },

        async getRetryCount(eventId: string): Promise<number> {
            const count = await redis.get(getRetryKey(eventId));
            return count ? parseInt(count, 10) : 0;
        },

        async sendToDLQ(event: BaseEvent, shard: string, error: string): Promise<string> {
            const dlqKey = getDLQStreamKey(shard);
            const now = new Date().toISOString();

            const entry: Omit<DLQEntry, 'id'> = {
                event,
                error,
                retryCount: config.maxRetries,
                firstFailedAt: now,
                lastFailedAt: now,
                shard,
            };

            const id = await redis.xadd(
                dlqKey,
                'MAXLEN', '~', String(config.dlqMaxLen),
                '*',
                'data', JSON.stringify(entry)
            );

            logger.error('Event moved to DLQ', {
                event_id: event.event_id,
                match_id: event.match_id,
                shard,
                dlq_id: id,
                error,
            });

            return id as string;
        },

        async getDLQEntries(shard: string, count = 100): Promise<DLQEntry[]> {
            const dlqKey = getDLQStreamKey(shard);

            const result = await redis.xrange(dlqKey, '-', '+', 'COUNT', count);

            const entries: DLQEntry[] = [];
            for (const [id, fields] of result) {
                const dataIdx = fields.indexOf('data');
                if (dataIdx !== -1 && fields[dataIdx + 1]) {
                    try {
                        const entry = JSON.parse(fields[dataIdx + 1]!) as Omit<DLQEntry, 'id'>;
                        entries.push({ ...entry, id });
                    } catch {
                        // Skip malformed entries
                    }
                }
            }

            return entries;
        },

        async getDLQShards(): Promise<string[]> {
            const keys = await redis.keys(`${dlqStreamPrefix}*`);
            return keys.map(key => key.replace(dlqStreamPrefix, '')).sort();
        },

        async requeueEvent(shard: string, dlqEntryId: string): Promise<boolean> {
            const dlqKey = getDLQStreamKey(shard);
            const mainStreamKey = `events:${shard}`;

            // Get the entry
            const result = await redis.xrange(dlqKey, dlqEntryId, dlqEntryId, 'COUNT', 1);

            if (result.length === 0) {
                return false;
            }

            const [, fields] = result[0]!;
            const dataIdx = fields.indexOf('data');

            if (dataIdx === -1 || !fields[dataIdx + 1]) {
                return false;
            }

            const entry = JSON.parse(fields[dataIdx + 1]!) as Omit<DLQEntry, 'id'>;

            // Add back to main stream
            await redis.xadd(
                mainStreamKey,
                '*',
                'data', JSON.stringify(entry.event),
                'type', entry.event.type,
                'event_id', entry.event.event_id,
                'requeued', 'true'
            );

            // Remove from DLQ
            await redis.xdel(dlqKey, dlqEntryId);

            logger.info('Event requeued from DLQ', {
                event_id: entry.event.event_id,
                shard,
                dlq_id: dlqEntryId,
            });

            return true;
        },

        async requeueAll(shard: string): Promise<number> {
            const entries = await this.getDLQEntries(shard, 1000);
            let count = 0;

            for (const entry of entries) {
                if (await this.requeueEvent(shard, entry.id)) {
                    count++;
                }
            }

            logger.info('Requeued all DLQ events', { shard, count });
            return count;
        },

        async getStats(): Promise<{ totalEntries: number; byShardCounts: Record<string, number> }> {
            const shards = await this.getDLQShards();
            const byShardCounts: Record<string, number> = {};
            let totalEntries = 0;

            for (const shard of shards) {
                const dlqKey = getDLQStreamKey(shard);
                const length = await redis.xlen(dlqKey);
                byShardCounts[shard] = length;
                totalEntries += length;
            }

            return { totalEntries, byShardCounts };
        },

        async clearRetryCount(eventId: string): Promise<void> {
            await redis.del(getRetryKey(eventId));
        },
    };
}

export const DEFAULT_DLQ_CONFIG: DLQConfig = {
    maxRetries: 3,
    retryDelayMs: 1000,
    dlqStreamPrefix: 'dlq:events:',
    dlqMaxLen: 10000,
};
