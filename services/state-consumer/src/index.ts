/**
 * State Consumer Service (Production-Ready)
 * 
 * Features:
 * - Per-shard concurrency = 1 (distributed locks)
 * - DLQ with configurable retry policy
 * - Sequence number validation with reorder buffer
 * - Late event handling
 * - E2E latency tracking
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
    createDLQManager,
    createShardManager,
    createSequenceValidator,
    SLO,
    DEFAULT_DLQ_CONFIG,
    DEFAULT_SHARD_CONFIG,
    DEFAULT_SEQUENCE_CONFIG,
} from '@esports/shared';
import { config } from './config';
import { createStreamConsumer, runConsumerLoop, type StreamEntry } from './stream';
import { createStateManager } from './state';
import { createClickHouseWriter } from './clickhouse';
import { createPredictorClient } from './predictor-client';
import { createReplayService } from './replay';

const logger = createLogger('state-consumer', config.logLevel as 'debug' | 'info');
const metrics = createProductionMetrics('state_consumer');
const SERVICE_VERSION = '1.0.0';

// Shutdown state
const shutdownSignal = { stop: false };
let isReady = false;

// Metrics for ordering/DLQ
const orderingViolations = metrics.registry.createCounter(
    'state_consumer_ordering_violations_total',
    'Count of seq_no ordering violations',
    ['type']
);
const dlqEvents = metrics.registry.createCounter(
    'state_consumer_dlq_events_total',
    'Count of events sent to DLQ',
    ['shard']
);
const bufferedEvents = metrics.registry.createGauge(
    'state_consumer_buffered_events',
    'Number of events in reorder buffer',
    ['shard']
);

async function main() {
    logger.info('Starting State Consumer (Production Mode)', {
        version: SERVICE_VERSION,
        redis: config.redis.url,
        clickhouse: config.clickhouse.url,
        dlq_max_retries: DEFAULT_DLQ_CONFIG.maxRetries,
        max_lateness_ms: DEFAULT_SEQUENCE_CONFIG.maxLatenessMs,
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

    await redis.connect();
    logger.info('Connected to Redis');

    // Initialize components
    const streamConsumer = createStreamConsumer(redis);
    const stateManager = createStateManager(redis);
    const clickhouseWriter = createClickHouseWriter();
    const predictorClient = createPredictorClient();

    // New production components
    const dlqManager = createDLQManager(redis, DEFAULT_DLQ_CONFIG);
    const shardManager = createShardManager(redis, DEFAULT_SHARD_CONFIG);
    const sequenceValidator = createSequenceValidator(redis, DEFAULT_SEQUENCE_CONFIG);
    const replayService = createReplayService(redis);

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

    // Track active shard locks
    const heldLocks = new Set<string>();

    // Stats
    let processedCount = 0;
    let failedCount = 0;
    const startTime = Date.now();

    // =====================================
    // Event Handler with Full Features
    // =====================================

    const handleEvent = async (entry: StreamEntry) => {
        const event = entry.event as BaseEvent & { ts_ingest?: string; trace_id?: string };
        const shard = `${event.match_id}:${event.map_id}`;
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
            // 1. Acquire shard lock (per-shard concurrency = 1)
            if (!heldLocks.has(shard)) {
                const acquired = await shardManager.acquireLock(shard, consumerId);
                if (!acquired) {
                    // Another consumer is processing this shard
                    logger.debug('Shard locked by another consumer, skipping', { shard, ...logCtx });
                    return; // Will be retried
                }
                heldLocks.add(shard);
            }

            // 2. Validate sequence number
            const seqResult = await sequenceValidator.validate(event, shard);

            switch (seqResult.action) {
                case 'buffer':
                    orderingViolations.inc({ type: 'buffered' });
                    bufferedEvents.set(
                        sequenceValidator.getBuffer(shard).length,
                        { shard }
                    );
                    logger.debug('Event buffered for reordering', { ...logCtx, reason: seqResult.reason });
                    return; // Don't ACK - will be processed later

                case 'drop':
                    orderingViolations.inc({ type: 'dropped' });
                    logger.warn('Event dropped', { ...logCtx, reason: seqResult.reason });
                    return; // ACK but don't process

                case 'reprocess':
                    orderingViolations.inc({ type: 'reprocess' });
                    logger.info('Late event reprocessing', { ...logCtx, reason: seqResult.reason });
                    // Fall through to process
                    break;

                case 'process':
                    // Normal processing
                    break;
            }

            // Track queue lag
            const queueLag = calculateQueueLag(ctx);
            if (queueLag > 0) {
                metrics.queueLag.observe(queueLag);
            }

            // 3. Update match state in Redis
            const stateStart = performance.now();
            const state = await stateManager.updateMatchState(event);
            metrics.recordStage('state', performance.now() - stateStart);

            // 4. Publish state update for subscribers
            await stateManager.publishStateUpdate(event.match_id, state);

            // 5. Write raw event to ClickHouse (batched, async)
            clickhouseWriter.write(event);

            // 6. Trigger prediction if significant event
            const predictStart = performance.now();
            const prediction = await predictorClient.triggerPrediction(event, state);
            const predictLatency = performance.now() - predictStart;
            metrics.recordStage('predict', predictLatency);

            if (prediction) {
                clickhouseWriter.writePrediction(prediction, event);

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

            // 7. Process any buffered events that are now ready
            if (seqResult.bufferedEvents && seqResult.bufferedEvents.length > 0) {
                for (const bufferedEvent of seqResult.bufferedEvents) {
                    logger.info('Processing buffered event', {
                        event_id: bufferedEvent.event_id,
                        seq_no: bufferedEvent.seq_no,
                    });
                    // Recursive call for buffered events
                    await handleEvent({
                        id: `buffered-${bufferedEvent.event_id}`,
                        streamKey: entry.streamKey,
                        event: bufferedEvent,
                    });
                }
                bufferedEvents.set(
                    sequenceValidator.getBuffer(shard).length,
                    { shard }
                );
            }

            const totalLatency = performance.now() - processStart;
            metrics.eventsProcessed.inc({ type: event.type });
            processedCount++;

            // Clear DLQ retry count on success
            await dlqManager.clearRetryCount(event.event_id);

            logger.debug('Event processed', {
                ...logCtx,
                stream_id: entry.id,
                queue_lag_ms: queueLag.toFixed(0),
                process_latency_ms: totalLatency.toFixed(2),
            });

        } catch (error) {
            // Record failure and potentially move to DLQ
            const movedToDLQ = await dlqManager.recordFailure(
                event,
                shard,
                String(error)
            );

            if (movedToDLQ) {
                dlqEvents.inc({ shard });
                metrics.eventsFailed.inc({ type: event.type });
                failedCount++;
                // Don't throw - event is in DLQ now
                return;
            }

            // Re-throw for retry
            throw error;
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
        dlq_max_retries: DEFAULT_DLQ_CONFIG.maxRetries,
    });

    // =====================================
    // Lock Heartbeat (extend locks)
    // =====================================

    const lockHeartbeat = setInterval(async () => {
        for (const shard of heldLocks) {
            const extended = await shardManager.extendLock(shard, consumerId);
            if (!extended) {
                heldLocks.delete(shard);
                logger.warn('Lost shard lock', { shard, consumer: consumerId });
            }
        }
    }, 10000); // Every 10s

    // =====================================
    // Stats Logging
    // =====================================

    const statsInterval = setInterval(() => {
        const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
        const rate = uptimeSeconds > 0 ? (processedCount / uptimeSeconds).toFixed(2) : 0;
        const seqStats = sequenceValidator.getStats();

        logger.info('Processing stats', {
            processed: processedCount,
            failed: failedCount,
            rate_per_sec: rate,
            uptime_sec: uptimeSeconds,
            out_of_order: seqStats.outOfOrderEvents,
            gaps_detected: seqStats.gapsDetected,
            late_processed: seqStats.lateEventsProcessed,
            late_dropped: seqStats.lateEventsDropped,
            held_locks: heldLocks.size,
        });
    }, 30000);

    // =====================================
    // HTTP Server for Health/Metrics/Admin
    // =====================================

    const app = new Hono();

    // Health endpoints
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
        const seqStats = sequenceValidator.getStats();
        const dlqStats = await dlqManager.getStats();

        return c.json({
            ...result.body as object,
            consumer_id: consumerId,
            processed: processedCount,
            failed: failedCount,
            rate_per_sec: ((processedCount / Math.max(1, (Date.now() - startTime) / 1000))).toFixed(2),
            sequence_stats: seqStats,
            dlq_stats: dlqStats,
            held_locks: Array.from(heldLocks),
        }, result.status as 200 | 503);
    });

    // Metrics
    app.get('/metrics', (c) => {
        return new Response(metrics.registry.getMetrics(), {
            headers: { 'Content-Type': 'text/plain; version=0.0.4' },
        });
    });

    // DLQ Admin endpoints
    app.get('/admin/dlq/stats', async (c) => {
        const stats = await dlqManager.getStats();
        return c.json({ success: true, data: stats });
    });

    app.get('/admin/dlq/shards', async (c) => {
        const shards = await dlqManager.getDLQShards();
        return c.json({ success: true, data: shards });
    });

    app.get('/admin/dlq/shards/:shard', async (c) => {
        const shard = c.req.param('shard');
        const entries = await dlqManager.getDLQEntries(shard);
        return c.json({ success: true, data: entries });
    });

    app.post('/admin/dlq/requeue/:shard', async (c) => {
        const shard = c.req.param('shard');
        const count = await dlqManager.requeueAll(shard);
        return c.json({ success: true, requeued: count });
    });

    app.post('/admin/dlq/requeue/:shard/:entryId', async (c) => {
        const shard = c.req.param('shard');
        const entryId = c.req.param('entryId');
        const success = await dlqManager.requeueEvent(shard, entryId);
        return c.json({ success });
    });

    // Sequence stats
    app.get('/admin/sequence/stats', (c) => {
        return c.json({ success: true, data: sequenceValidator.getStats() });
    });

    // Replay endpoint
    app.post('/admin/replay/:matchId', async (c) => {
        const matchId = c.req.param('matchId');
        const namespace = c.req.query('namespace') || 'replay';
        try {
            const result = await replayService.replayMatch(matchId, namespace);
            return c.json({ success: true, data: result });
        } catch (e) {
            logger.error('Replay failed', { matchId, error: String(e) });
            return c.json({ success: false, error: String(e) }, 500);
        }
    });

    const httpServer = Bun.serve({
        port: config.metrics.port,
        fetch: app.fetch,
    });

    logger.info(`HTTP server on port ${config.metrics.port}`, {
        endpoints: ['/health', '/healthz', '/readyz', '/metrics', '/admin/dlq/*', '/admin/sequence/*'],
    });

    // =====================================
    // Graceful Shutdown
    // =====================================

    const shutdown = async (signal: string) => {
        if (shutdownSignal.stop) return;

        logger.info('Graceful shutdown started', { signal });

        // Stop accepting new work
        shutdownSignal.stop = true;
        isReady = false;

        // Stop intervals
        clearInterval(statsInterval);
        clearInterval(lockHeartbeat);

        // Release all locks
        for (const shard of heldLocks) {
            await shardManager.releaseLock(shard, consumerId);
        }
        heldLocks.clear();

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
            sequence_stats: sequenceValidator.getStats(),
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
