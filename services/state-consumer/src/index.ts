/**
 * State Consumer Service (Redis Streams version)
 * 
 * Consumes events from Redis Streams, updates match state in Redis,
 * writes raw events to ClickHouse, and triggers predictions.
 * 
 * Key features:
 * - Strict ordering per shard (match_id, map_id)
 * - Automatic discovery of new streams
 * - Claiming stale messages for fault tolerance
 * - Graceful shutdown
 */

import Redis from 'ioredis';
import type { BaseEvent } from '@esports/shared';
import { createLogger, MetricsRegistry } from '@esports/shared';
import { config } from './config';
import { createStreamConsumer, runConsumerLoop, type StreamEntry } from './stream';
import { createStateManager } from './state';
import { createClickHouseWriter } from './clickhouse';
import { createPredictorClient } from './predictor-client';

const logger = createLogger('state-consumer', config.logLevel as 'debug' | 'info');

// Metrics
const registry = new MetricsRegistry();
const eventsProcessed = registry.createCounter(
    'state_consumer_events_processed_total',
    'Total events processed',
    ['type']
);
const eventsFailed = registry.createCounter(
    'state_consumer_events_failed_total',
    'Total events failed',
    ['type']
);
const processingLatency = registry.createHistogram(
    'state_consumer_processing_latency_ms',
    'Event processing latency in milliseconds',
    ['type'],
    [1, 5, 10, 25, 50, 100, 250, 500]
);
const e2eLatency = registry.createHistogram(
    'state_consumer_e2e_latency_ms',
    'End-to-end latency from event timestamp',
    [],
    [50, 100, 200, 300, 400, 500, 750, 1000]
);

async function main() {
    logger.info('Starting State Consumer (Redis Streams mode)', {
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
    const streamConsumer = createStreamConsumer(redis);
    const stateManager = createStateManager(redis);
    const clickhouseWriter = createClickHouseWriter();
    const predictorClient = createPredictorClient();

    // Generate unique consumer ID
    const consumerId = `consumer-${process.pid}-${Date.now()}`;

    // Signal for graceful shutdown
    const signal = { stop: false };

    // Stats
    let processedCount = 0;
    let failedCount = 0;
    const startTime = Date.now();

    // Event handler
    const handleEvent = async (entry: StreamEntry) => {
        const event = entry.event;
        const startMs = performance.now();

        try {
            // 1. Update match state in Redis
            const state = await stateManager.updateMatchState(event);

            // 2. Publish state update for subscribers
            await stateManager.publishStateUpdate(event.match_id, state);

            // 3. Write raw event to ClickHouse (batched, async)
            clickhouseWriter.write(event);

            // 4. Trigger prediction if significant event
            await predictorClient.triggerPrediction(event, state);

            const latencyMs = performance.now() - startMs;

            // Calculate e2e latency (from event timestamp)
            if (event.ts_ingest) {
                const ingestTime = new Date(event.ts_ingest).getTime();
                const e2eMs = Date.now() - ingestTime;
                e2eLatency.observe(e2eMs);
            }

            eventsProcessed.inc({ type: event.type });
            processingLatency.observe(latencyMs, { type: event.type });
            processedCount++;

            logger.debug('Event processed', {
                event_id: event.event_id,
                type: event.type,
                match_id: event.match_id,
                stream_id: entry.id,
                latency_ms: latencyMs.toFixed(2),
            });

        } catch (error) {
            eventsFailed.inc({ type: event.type });
            failedCount++;
            throw error; // Re-throw to prevent ACK
        }
    };

    // Error handler
    const handleError = async (error: Error, entry: StreamEntry) => {
        logger.error('Event processing failed', {
            event_id: entry.event.event_id,
            stream: entry.streamKey,
            id: entry.id,
            error: String(error),
        });
    };

    // Start consumer loop
    const consumerPromise = runConsumerLoop(streamConsumer, {
        consumerId,
        onEvent: handleEvent,
        onError: handleError,
        batchSize: config.queue.concurrency,
        blockMs: 2000,
        discoveryIntervalMs: 5000,
    }, signal);

    logger.info('State Consumer ready', {
        consumerId,
        mode: 'redis-streams',
    });

    // Stats logging
    const statsInterval = setInterval(() => {
        const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
        const rate = uptimeSeconds > 0 ? (processedCount / uptimeSeconds).toFixed(2) : 0;

        logger.info('Stats', {
            processed: processedCount,
            failed: failedCount,
            rate_per_sec: rate,
            uptime_sec: uptimeSeconds,
        });
    }, 30000);

    // Metrics endpoint
    const metricsServer = Bun.serve({
        port: config.queue.concurrency > 1 ? 8091 : 8090, // Avoid port conflicts
        fetch: (req) => {
            const url = new URL(req.url);

            if (url.pathname === '/health') {
                return Response.json({
                    status: 'healthy',
                    mode: 'redis-streams',
                    consumerId,
                    processed: processedCount,
                    failed: failedCount,
                });
            }

            if (url.pathname === '/metrics') {
                return new Response(registry.getMetrics(), {
                    headers: { 'Content-Type': 'text/plain; version=0.0.4' },
                });
            }

            return new Response('Not Found', { status: 404 });
        },
    });

    logger.info(`Metrics server on port ${metricsServer.port}`);

    // Graceful shutdown
    const shutdown = async () => {
        logger.info('Shutting down...');

        signal.stop = true;
        clearInterval(statsInterval);

        // Wait for consumer loop to finish
        await consumerPromise;

        // Flush ClickHouse buffer
        await clickhouseWriter.close();

        // Close connections
        metricsServer.stop();
        await redis.quit();

        logger.info('Shutdown complete', {
            processed: processedCount,
            failed: failedCount,
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
