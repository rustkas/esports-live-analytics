/**
 * Sequence Number Validator & Reorder Buffer
 * 
 * Ensures event ordering via seq_no validation:
 * - Tracks last seen seq_no per shard
 * - Detects gaps and out-of-order events
 * - Soft reorder buffer for late arrivals (max 2s lateness)
 * - Metrics for ordering violations
 */

import type { Redis } from 'ioredis';
import type { BaseEvent } from '@esports/shared';
import { createLogger } from '@esports/shared';

const logger = createLogger('sequence');

export interface SequenceConfig {
    maxLatenessMs: number;       // Max time to buffer late events (default: 2000ms)
    bufferSize: number;          // Max events in reorder buffer per shard
    gapThreshold: number;        // Max gap before logging warning
    seqNoTtlSeconds: number;     // TTL for seq_no tracking in Redis
}

export interface BufferedEvent {
    event: BaseEvent;
    receivedAt: number;
    expectedSeqNo: number;
}

export interface SequenceStats {
    totalEvents: number;
    outOfOrderEvents: number;
    gapsDetected: number;
    lateEventsProcessed: number;
    lateEventsDropped: number;
}

export interface SequenceValidator {
    /**
     * Validate and potentially buffer an event
     * Returns: 'process' | 'buffer' | 'drop' | 'reprocess'
     */
    validate(event: BaseEvent, shard: string): Promise<{
        action: 'process' | 'buffer' | 'drop' | 'reprocess';
        reason?: string;
        bufferedEvents?: BaseEvent[];
    }>;

    /**
     * Get last seen seq_no for a shard
     */
    getLastSeqNo(shard: string): Promise<number>;

    /**
     * Set last seen seq_no
     */
    setLastSeqNo(shard: string, seqNo: number): Promise<void>;

    /**
     * Get buffered events for a shard
     */
    getBuffer(shard: string): BufferedEvent[];

    /**
     * Flush buffer (for shutdown or force processing)
     */
    flushBuffer(shard: string): BaseEvent[];

    /**
     * Get stats
     */
    getStats(): SequenceStats;

    /**
     * Check if seq_no is monotonically increasing
     */
    isMonotonic(lastSeqNo: number, currentSeqNo: number): boolean;
}

export function createSequenceValidator(
    redis: Redis,
    config: SequenceConfig
): SequenceValidator {
    const seqKeyPrefix = 'seq:last:';
    const buffers = new Map<string, BufferedEvent[]>();

    const stats: SequenceStats = {
        totalEvents: 0,
        outOfOrderEvents: 0,
        gapsDetected: 0,
        lateEventsProcessed: 0,
        lateEventsDropped: 0,
    };

    const getSeqKey = (shard: string) => `${seqKeyPrefix}${shard}`;

    const processBuffer = (shard: string, targetSeqNo: number): BaseEvent[] => {
        const buffer = buffers.get(shard) || [];
        const toProcess: BaseEvent[] = [];
        const remaining: BufferedEvent[] = [];
        const now = Date.now();

        for (const entry of buffer) {
            // If event matches expected seq_no or has expired, process it
            if (entry.event.seq_no === targetSeqNo) {
                toProcess.push(entry.event);
                stats.lateEventsProcessed++;
            } else if (now - entry.receivedAt > config.maxLatenessMs) {
                // Late event timeout - drop it
                logger.warn('Late event dropped', {
                    event_id: entry.event.event_id,
                    seq_no: entry.event.seq_no,
                    expected: entry.expectedSeqNo,
                    age_ms: now - entry.receivedAt,
                });
                stats.lateEventsDropped++;
            } else {
                remaining.push(entry);
            }
        }

        if (remaining.length > 0) {
            buffers.set(shard, remaining);
        } else {
            buffers.delete(shard);
        }

        return toProcess;
    };

    return {
        async validate(event: BaseEvent, shard: string) {
            stats.totalEvents++;

            const lastSeqNo = await this.getLastSeqNo(shard);
            const currentSeqNo = event.seq_no;
            const expectedSeqNo = lastSeqNo + 1;

            // First event or exactly next in sequence
            if (lastSeqNo === -1 || currentSeqNo === expectedSeqNo) {
                await this.setLastSeqNo(shard, currentSeqNo);

                // Check if any buffered events can now be processed
                const bufferedToProcess = processBuffer(shard, currentSeqNo + 1);

                return {
                    action: 'process',
                    bufferedEvents: bufferedToProcess.length > 0 ? bufferedToProcess : undefined,
                };
            }

            // Gap detected - events missing
            if (currentSeqNo > expectedSeqNo) {
                const gap = currentSeqNo - expectedSeqNo;
                stats.gapsDetected++;

                logger.warn('Sequence gap detected', {
                    event_id: event.event_id,
                    match_id: event.match_id,
                    expected_seq: expectedSeqNo,
                    actual_seq: currentSeqNo,
                    gap,
                    shard,
                });

                // For small gaps, buffer the current event
                if (gap <= config.gapThreshold) {
                    const buffer = buffers.get(shard) || [];

                    // Check buffer size limit
                    if (buffer.length < config.bufferSize) {
                        buffer.push({
                            event,
                            receivedAt: Date.now(),
                            expectedSeqNo,
                        });
                        buffers.set(shard, buffer);

                        return {
                            action: 'buffer',
                            reason: `Buffered while waiting for seq_no ${expectedSeqNo}`,
                        };
                    }
                }

                // Gap too large or buffer full - process anyway and update seq_no
                await this.setLastSeqNo(shard, currentSeqNo);
                return {
                    action: 'process',
                    reason: 'Processed despite gap (gap too large or buffer full)',
                };
            }

            // Out of order - seq_no less than expected (duplicate or late)
            stats.outOfOrderEvents++;

            const eventTime = new Date(event.ts_event).getTime();
            const age = Date.now() - eventTime;

            logger.info('Out of order event', {
                event_id: event.event_id,
                match_id: event.match_id,
                seq_no: currentSeqNo,
                expected: expectedSeqNo,
                age_ms: age,
                shard,
            });

            // If within lateness window, allow reprocessing
            if (age <= config.maxLatenessMs) {
                return {
                    action: 'reprocess',
                    reason: 'Late event within acceptable window',
                };
            }

            // Too late - drop
            stats.lateEventsDropped++;
            return {
                action: 'drop',
                reason: `Event too late (age: ${age}ms, max: ${config.maxLatenessMs}ms)`,
            };
        },

        async getLastSeqNo(shard: string): Promise<number> {
            const value = await redis.get(getSeqKey(shard));
            return value ? parseInt(value, 10) : -1;
        },

        async setLastSeqNo(shard: string, seqNo: number): Promise<void> {
            const key = getSeqKey(shard);
            await redis.set(key, String(seqNo), 'EX', config.seqNoTtlSeconds);
        },

        getBuffer(shard: string): BufferedEvent[] {
            return buffers.get(shard) || [];
        },

        flushBuffer(shard: string): BaseEvent[] {
            const buffer = buffers.get(shard) || [];
            buffers.delete(shard);
            return buffer.map(b => b.event);
        },

        getStats(): SequenceStats {
            return { ...stats };
        },

        isMonotonic(lastSeqNo: number, currentSeqNo: number): boolean {
            return lastSeqNo === -1 || currentSeqNo === lastSeqNo + 1;
        },
    };
}

export const DEFAULT_SEQUENCE_CONFIG: SequenceConfig = {
    maxLatenessMs: 2000,
    bufferSize: 100,
    gapThreshold: 10,
    seqNoTtlSeconds: 3600 * 2, // 2 hours
};
