/**
 * State Consumer Service
 * 
 * Consumes events from BullMQ queue, updates match state in Redis,
 * writes raw events to ClickHouse, and triggers predictions.
 */

import { Worker, type Job } from 'bullmq';
import Redis from 'ioredis';
import type { BaseEvent } from '@esports/shared';
import { createLogger } from '@esports/shared';
import { config } from './config';
import { createStateManager } from './state';
import { createClickHouseWriter } from './clickhouse';
import { createPredictorClient } from './predictor-client';

const logger = createLogger('state-consumer', config.logLevel as 'debug' | 'info');

async function main() {
    logger.info('Starting State Consumer', {
        redis: config.redis.url,
        clickhouse: config.clickhouse.url,
        concurrency: config.queue.concurrency,
    });

    // Connect to Redis
    const redis = new Redis(config.redis.url, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        lazyConnect: true,
    });

    redis.on('error', (err) => {
        logger.error('Redis connection error', { error: String(err) });
    });

    redis.on('connect', () => {
        logger.info('Connected to Redis');
    });

    await redis.connect();

    // Initialize components
    const stateManager = createStateManager(redis);
    const clickhouseWriter = createClickHouseWriter();
    const predictorClient = createPredictorClient();

    // Metrics
    let eventsProcessed = 0;
    let eventsFailed = 0;
    const startTime = Date.now();

    // Create worker
    const worker = new Worker(
        config.queue.name,
        async (job: Job<BaseEvent>) => {
            const event = job.data;
            const startMs = performance.now();

            try {
                // 1. Update match state in Redis
                const state = await stateManager.updateMatchState(event);

                // 2. Publish state update for subscribers
                await stateManager.publishStateUpdate(event.match_id, state);

                // 3. Write raw event to ClickHouse
                clickhouseWriter.write(event);

                // 4. Trigger prediction if significant event
                await predictorClient.triggerPrediction(event, state);

                eventsProcessed++;

                const latencyMs = performance.now() - startMs;

                logger.debug('Event processed', {
                    event_id: event.event_id,
                    type: event.type,
                    match_id: event.match_id,
                    latency_ms: latencyMs.toFixed(2),
                });

            } catch (error) {
                eventsFailed++;
                logger.error('Event processing failed', {
                    event_id: event.event_id,
                    error: String(error),
                });
                throw error; // Re-throw to trigger BullMQ retry
            }
        },
        {
            connection: redis.duplicate(),
            concurrency: config.queue.concurrency,
            limiter: {
                max: 1000,
                duration: 1000, // 1000 jobs per second max
            },
        }
    );

    worker.on('completed', (job) => {
        logger.debug('Job completed', { jobId: job.id });
    });

    worker.on('failed', (job, error) => {
        logger.error('Job failed', {
            jobId: job?.id,
            error: String(error),
        });
    });

    worker.on('error', (error) => {
        logger.error('Worker error', { error: String(error) });
    });

    logger.info('State Consumer ready, waiting for events...');

    // Stats logging
    const statsInterval = setInterval(() => {
        const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
        const rate = uptimeSeconds > 0 ? (eventsProcessed / uptimeSeconds).toFixed(2) : 0;

        logger.info('Stats', {
            processed: eventsProcessed,
            failed: eventsFailed,
            rate_per_sec: rate,
            uptime_sec: uptimeSeconds,
        });
    }, 30000);

    // Graceful shutdown
    const shutdown = async () => {
        logger.info('Shutting down...');

        clearInterval(statsInterval);

        await worker.close();
        await clickhouseWriter.close();
        await redis.quit();

        logger.info('Shutdown complete', {
            processed: eventsProcessed,
            failed: eventsFailed,
        });

        process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

main().catch((error) => {
    console.error('Failed to start service:', error);
    process.exit(1);
});
