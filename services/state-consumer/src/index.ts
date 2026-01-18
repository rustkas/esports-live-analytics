/**
 * State Consumer Service
 * 
 * Consumes events from Redis Streams and:
 * - Updates match state in Redis
 * - Writes raw events to ClickHouse
 * - Triggers predictions
 * - Tracks e2e latency
 * 
 * Features:
 * - Strict ordering per shard (match_id, map_id)
 * - Trace ID propagation
 * - Queue lag metrics
 * - Health checks
 * - Graceful shutdown with drain
 */

import { Hono } from 'hono';
import Redis from 'ioredis';
import type { BaseEvent } from '@esports/shared';
import {
    createLogger,
    createHealthChecks,
    createProductionMetrics,
    createEventContext,
    calculateQueueLag,
    getLogContext,
    SLO,
} from '@esports/shared';
import { config } from './config';
import { createStreamConsumer, runConsumerLoop, type StreamEntry } from './stream';
import { createStateManager } from './state';
import { createClickHouseWriter } from './clickhouse';
import { createPredictorClient } from './predictor-client';

const logger = createLogger('state-consumer', config.logLevel as 'debug' | 'info');
const metrics = createProductionMetrics('state_consumer');
const SERVICE_VERSION = '1.0.0';

// Shutdown state
const shutdownSignal = { stop: false };
let isReady = false;

async function main() {
    logger.info('Starting State Consumer', {
        version: SERVICE_VERSION,
        redis: config.redis.url,
        clickhouse: config.clickhouse.url,
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
    const streamConsumer = createStreamConsumer(redis);
    const stateManager = createStateManager(redis);
    const clickhouseWriter = createClickHouseWriter();
    const predictorClient = createPredictorClient();

    // Generate unique consumer ID
    const consumerId = `consumer-${process.pid}-${Date.now()}`;

    // Health checks
    const health = createHealthChecks(SERVICE_VERSION, [
        {
            name: 'redis',
            check: async () => {
                try {
                    await redis.ping();
                    return true;
                } catch {
                    return false;
                }
            },
        },
        {
            name: 'clickhouse',
            check: async () => clickhouseWriter.isHealthy(),
        },
    ]);

    // Stats
    let processedCount = 0;
    let failedCount = 0;
    const startTime = Date.now();

    // =====================================
    // Event Handler with Full Tracing
    // =====================================

    const handleEvent = async (entry: StreamEntry) => {
        const event = entry.event as BaseEvent & { ts_ingest?: string; trace_id?: string };
        const processStart = performance.now();

        // Create context for tracing
        const ctx = createEventContext({
            event_id: event.event_id,
            match_id: event.match_id,
            map_id: event.map_id,
            type: event.type,
            ts_ingest: event.ts_ingest,
            trace_id: event.trace_id,
        });
        ctx.ts_process_start = Date.now();

        const logCtx = getLogContext(ctx);

        try {
            // Track queue lag
            const queueLag = calculateQueueLag(ctx);
            if (queueLag > 0) {
                metrics.queueLag.observe(queueLag);
            }

            // 1. Update match state in Redis
            const stateStart = performance.now();
            const state = await stateManager.updateMatchState(event);
            metrics.recordStage('state', performance.now() - stateStart);

            // 2. Publish state update for subscribers
            await stateManager.publishStateUpdate(event.match_id, state);

            // 3. Write raw event to ClickHouse (batched, async)
            clickhouseWriter.write(event);

            // 4. Trigger prediction if significant event
            const predictStart = performance.now();
            const prediction = await predictorClient.triggerPrediction(event, state);
            const predictLatency = performance.now() - predictStart;
            metrics.recordStage('predict', predictLatency);

            if (prediction) {
                ctx.ts_predict_published = Date.now();

                // Calculate and record e2e latency
                const e2eLatency = ctx.ts_predict_published - ctx.ts_ingest;
                metrics.recordE2ELatency(e2eLatency, event.type);

                // Log warning if approaching SLO
                if (e2eLatency > SLO.E2E_LATENCY_WARNING_MS) {
                    logger.warn('E2E latency warning', {
                        ...logCtx,
                        e2e_latency_ms: e2eLatency,
                        queue_lag_ms: queueLag,
                        slo_threshold_ms: SLO.E2E_LATENCY_P95_MS,
                    });
                }
            }

            const totalLatency = performance.now() - processStart;
            metrics.eventsProcessed.inc({ type: event.type });
            processedCount++;

            logger.debug('Event processed', {
                ...logCtx,
                stream_id: entry.id,
                queue_lag_ms: queueLag.toFixed(0),
                process_latency_ms: totalLatency.toFixed(2),
            });

        } catch (error) {
            metrics.eventsFailed.inc({ type: event.type });
            failedCount++;

            logger.error('Event processing failed', {
                ...logCtx,
                stream: entry.streamKey,
                id: entry.id,
                error: String(error),
            });

            throw error; // Re-throw to prevent ACK
        }
    };

    // Error handler
    const handleError = async (error: Error, entry: StreamEntry) => {
        logger.error('Event handler error', {
            event_id: entry.event.event_id,
            match_id: entry.event.match_id,
            error: String(error),
        });
    };

    // Mark as ready
    isReady = true;

    // Start consumer loop
    const consumerPromise = runConsumerLoop(streamConsumer, {
        consumerId,
        onEvent: handleEvent,
        onError: handleError,
        batchSize: config.consumer.batchSize,
        blockMs: config.consumer.blockMs,
        discoveryIntervalMs: config.consumer.discoveryIntervalMs,
    }, shutdownSignal);

    logger.info('State Consumer ready', {
        consumerId,
        batch_size: config.consumer.batchSize,
    });

    // =====================================
    // Stats Logging
    // =====================================

    const statsInterval = setInterval(() => {
        const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
        const rate = uptimeSeconds > 0 ? (processedCount / uptimeSeconds).toFixed(2) : 0;

        logger.info('Processing stats', {
            processed: processedCount,
            failed: failedCount,
            rate_per_sec: rate,
            uptime_sec: uptimeSeconds,
        });
    }, 30000);

    // =====================================
    // HTTP Server for Health/Metrics
    // =====================================

    const app = new Hono();

    app.get('/healthz', async (c) => {
        const result = await health.healthz();
        return c.json(result.body, result.status as 200);
    });

    app.get('/readyz', async (c) => {
        if (!isReady) {
            return c.json({ status: 'not ready' }, 503);
        }
        const result = await health.readyz();
        return c.json(result.body, result.status as 200 | 503);
    });

    app.get('/health', async (c) => {
        const result = await health.health();
        return c.json({
            ...result.body as object,
            consumer_id: consumerId,
            processed: processedCount,
            failed: failedCount,
            rate_per_sec: ((processedCount / Math.max(1, (Date.now() - startTime) / 1000))).toFixed(2),
        }, result.status as 200 | 503);
    });

    app.get('/metrics', (c) => {
        return new Response(metrics.registry.getMetrics(), {
            headers: { 'Content-Type': 'text/plain; version=0.0.4' },
        });
    });

    const httpServer = Bun.serve({
        port: config.metrics.port,
        fetch: app.fetch,
    });

    logger.info(`Metrics server on port ${config.metrics.port}`);

    // =====================================
    // Graceful Shutdown
    // =====================================

    const shutdown = async (signal: string) => {
        if (shutdownSignal.stop) return;

        logger.info('Graceful shutdown started', { signal });

        // Stop accepting new work
        shutdownSignal.stop = true;
        isReady = false;

        // Stop stats logging
        clearInterval(statsInterval);

        // Wait for consumer loop to finish current batch
        await consumerPromise;

        // Flush ClickHouse buffer
        await clickhouseWriter.close();

        // Close HTTP server
        httpServer.stop();

        // Close Redis
        await redis.quit();

        logger.info('Shutdown complete', {
            processed: processedCount,
            failed: failedCount,
        });

        process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
    console.error('Failed to start service:', error);
    process.exit(1);
});
