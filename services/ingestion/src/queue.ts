/**
 * BullMQ Queue Manager
 * Handles event queueing with retries and backpressure
 */

import { Queue, QueueEvents } from 'bullmq';
import type { Redis } from 'ioredis';
import type { BaseEvent } from '@esports/shared';
import { createLogger } from '@esports/shared';
import { config } from './config';

const logger = createLogger('ingestion:queue', config.logLevel as 'debug' | 'info');

export interface QueueManager {
    enqueue(event: BaseEvent): Promise<string>;
    getStats(): Promise<QueueStats>;
    close(): Promise<void>;
}

export interface QueueStats {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
}

export function createQueueManager(redisConnection: Redis): QueueManager {
    const queue = new Queue(config.queue.name, {
        connection: redisConnection,
        defaultJobOptions: {
            attempts: config.queue.attempts,
            backoff: {
                type: 'exponential',
                delay: config.queue.backoffDelay,
            },
            removeOnComplete: {
                age: 3600, // 1 hour
                count: 1000,
            },
            removeOnFail: {
                age: 86400, // 24 hours
            },
        },
    });

    const events = new QueueEvents(config.queue.name, {
        connection: redisConnection.duplicate(),
    });

    // Log queue events
    events.on('completed', ({ jobId }) => {
        logger.debug('Job completed', { jobId });
    });

    events.on('failed', ({ jobId, failedReason }) => {
        logger.error('Job failed', { jobId, reason: failedReason });
    });

    return {
        async enqueue(event: BaseEvent): Promise<string> {
            const job = await queue.add(event.type, event, {
                jobId: event.event_id, // Use event_id for idempotency
                priority: getEventPriority(event.type),
            });

            logger.debug('Event enqueued', {
                event_id: event.event_id,
                type: event.type,
                job_id: job.id,
            });

            return job.id!;
        },

        async getStats(): Promise<QueueStats> {
            const [waiting, active, completed, failed, delayed] = await Promise.all([
                queue.getWaitingCount(),
                queue.getActiveCount(),
                queue.getCompletedCount(),
                queue.getFailedCount(),
                queue.getDelayedCount(),
            ]);

            return { waiting, active, completed, failed, delayed };
        },

        async close(): Promise<void> {
            await events.close();
            await queue.close();
        },
    };
}

/**
 * Priority for different event types
 * Lower number = higher priority
 */
function getEventPriority(eventType: string): number {
    const priorities: Record<string, number> = {
        round_end: 1,
        kill: 2,
        bomb_planted: 2,
        bomb_defused: 2,
        bomb_exploded: 2,
        round_start: 3,
        economy_update: 4,
        player_hurt: 5,
    };

    return priorities[eventType] ?? 10;
}
