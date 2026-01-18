/**
 * Ingestion Service
 * 
 * HTTP intake for CS2 game events.
 * Features:
 * - Event validation with schema versioning
 * - Payload size limits
 * - Deduplication (using bounded match sets)
 * - Redis Streams publishing
 * - Trace ID propagation
 * - DLQ and Retry policy
 * - Admin API for DLQ management
 * - Health checks (/healthz, /readyz, /health)
 * - Graceful shutdown
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import Redis from 'ioredis';
import {
    createLogger,
    createHealthChecks,
    createProductionMetrics,
    ensureTraceId,
    validateEvent,
    createDedupService,
    createDLQManager,
    PAYLOAD_LIMITS,
    DEFAULT_DLQ_CONFIG,
    DEFAULT_DEDUP_CONFIG,
} from '@esports/shared';
import { config } from './config';
import { createStreamPublisher } from './stream';
import { createAdminRoutes } from './admin';

const logger = createLogger('ingestion', config.logLevel as 'debug' | 'info');
const metrics = createProductionMetrics('ingestion');
const SERVICE_VERSION = '1.0.0';

// Shutdown state
let isShuttingDown = false;

async function main() {
    logger.info('Starting Ingestion Service', {
        version: SERVICE_VERSION,
        port: config.port,
        redis: config.redis.url,
        max_payload_bytes: PAYLOAD_LIMITS.MAX_EVENT_SIZE_BYTES,
    });

    // Connect to Redis
    const redis = new Redis(config.redis.url, {
        lazyConnect: true,
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => Math.min(times * 100, 3000),
    });

    redis.on('error', (err) => {
        logger.error('Redis connection error', { error: String(err) });
    });

    redis.on('connect', () => {
        logger.info('Connected to Redis');
    });

    await redis.connect();

    // Initialize components
    const stream = createStreamPublisher(redis);
    await stream.init();

    const dedup = createDedupService(redis, {
        ...DEFAULT_DEDUP_CONFIG,
        ttlSeconds: config.dedup.ttlSeconds,
    });

    const dlq = createDLQManager(redis, DEFAULT_DLQ_CONFIG);

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
    ]);

    logger.info('Components initialized');

    // Create Hono app
    const app = new Hono();
    app.use('*', cors());

    // Request tracking middleware
    app.use('*', async (c, next) => {
        if (isShuttingDown) {
            return c.json({ error: 'Service is shutting down' }, 503);
        }

        const start = performance.now();
        await next();
        const latency = performance.now() - start;

        const path = c.req.path.split('/').slice(0, 3).join('/') || '/';
        metrics.requests.inc({
            method: c.req.method,
            path,
            status: String(c.res.status),
        });
        metrics.requestLatency.observe(latency, { method: c.req.method, path });
    });

    // =====================================
    // Admin Routes (mounted first)
    // =====================================

    const adminRoutes = createAdminRoutes(dlq);
    app.route('/admin', adminRoutes);

    // =====================================
    // Health Endpoints
    // =====================================

    app.get('/healthz', async (c) => {
        const result = await health.healthz();
        return c.json(result.body, result.status as 200);
    });

    app.get('/readyz', async (c) => {
        const result = await health.readyz();
        return c.json(result.body, result.status as 200 | 503);
    });

    app.get('/health', async (c) => {
        const result = await health.health();
        return c.json(result.body, result.status as 200 | 503);
    });

    // =====================================
    // Metrics Endpoint
    // =====================================

    app.get('/metrics', (c) => {
        c.header('Content-Type', 'text/plain; version=0.0.4');
        return c.text(metrics.registry.getMetrics());
    });

    // =====================================
    // Event Ingestion
    // =====================================

    app.post('/events', async (c) => {
        const stageStart = performance.now();

        try {
            const body = await c.req.json();

            // Add trace_id if not present
            const eventWithTrace = ensureTraceId(body);

            // Record ingestion start
            const tsIngest = new Date().toISOString();
            eventWithTrace.ts_ingest = tsIngest;

            // Validate event (includes size check)
            const validation = validateEvent(eventWithTrace);
            if (!validation.success) {
                metrics.errors.inc({ type: 'validation' });
                return c.json({
                    success: false,
                    error: {
                        code: 'VALIDATION_ERROR',
                        message: 'Invalid event format',
                        details: validation.error.errors,
                    },
                }, 400);
            }

            const event = validation.data;

            // Log with context
            const logContext = {
                trace_id: event.trace_id,
                match_id: event.match_id,
                map_id: event.map_id,
                event_id: event.event_id,
                type: event.type,
            };

            // Check for duplicates
            if (await dedup.isDuplicate(event.event_id, event.match_id)) {
                logger.debug('Duplicate event', logContext);
                return c.json({
                    success: true,
                    message: 'Event already processed',
                    event_id: event.event_id,
                    duplicate: true,
                }, 200);
            }

            // Publish to Redis Stream
            const streamId = await stream.publish(event);

            // Mark as seen
            await dedup.markSeen(event.event_id, event.match_id);

            // Record metrics
            const ingestLatency = performance.now() - stageStart;
            metrics.eventsProcessed.inc({ type: event.type });
            metrics.recordStage('ingest', ingestLatency);

            logger.info('Event ingested', {
                ...logContext,
                stream_id: streamId,
                latency_ms: ingestLatency.toFixed(2),
            });

            return c.json({
                success: true,
                event_id: event.event_id,
                trace_id: event.trace_id,
                stream_id: streamId,
                latency_ms: ingestLatency,
            });

        } catch (error) {
            metrics.errors.inc({ type: 'ingestion' });
            logger.error('Ingestion error', { error: String(error) });

            return c.json({
                success: false,
                error: {
                    code: 'INTERNAL_ERROR',
                    message: 'Failed to process event',
                },
            }, 500);
        }
    });

    // Batch endpoint
    app.post('/events/batch', async (c) => {
        const stageStart = performance.now();

        try {
            const body = await c.req.json();

            if (!Array.isArray(body)) {
                return c.json({
                    success: false,
                    error: { code: 'VALIDATION_ERROR', message: 'Expected array' },
                }, 400);
            }

            if (body.length > PAYLOAD_LIMITS.MAX_BATCH_SIZE) {
                return c.json({
                    success: false,
                    error: {
                        code: 'BATCH_TOO_LARGE',
                        message: `Max batch size is ${PAYLOAD_LIMITS.MAX_BATCH_SIZE}`,
                    },
                }, 400);
            }

            const results: Array<{
                event_id: string;
                success: boolean;
                trace_id?: string;
                stream_id?: string;
                duplicate?: boolean;
                error?: string;
            }> = [];

            let processed = 0;
            let duplicates = 0;
            let errors = 0;

            for (const item of body) {
                const eventWithTrace = ensureTraceId(item);
                eventWithTrace.ts_ingest = new Date().toISOString();

                const validation = validateEvent(eventWithTrace);

                if (!validation.success) {
                    errors++;
                    results.push({
                        event_id: item.event_id ?? 'unknown',
                        success: false,
                        error: 'Validation failed',
                    });
                    continue;
                }

                const event = validation.data;

                if (await dedup.isDuplicate(event.event_id, event.match_id)) {
                    duplicates++;
                    results.push({
                        event_id: event.event_id,
                        trace_id: event.trace_id,
                        success: true,
                        duplicate: true,
                    });
                    continue;
                }

                try {
                    const streamId = await stream.publish(event);
                    await dedup.markSeen(event.event_id, event.match_id);

                    processed++;
                    metrics.eventsProcessed.inc({ type: event.type });

                    results.push({
                        event_id: event.event_id,
                        trace_id: event.trace_id,
                        success: true,
                        stream_id: streamId,
                    });
                } catch {
                    errors++;
                    results.push({
                        event_id: event.event_id,
                        success: false,
                        error: 'Stream error',
                    });
                }
            }

            const latency = performance.now() - stageStart;

            logger.info('Batch processed', {
                total: body.length,
                processed,
                duplicates,
                errors,
                latency_ms: latency.toFixed(2),
            });

            return c.json({
                success: true,
                total: body.length,
                processed,
                duplicates,
                errors,
                results,
                latency_ms: latency,
            });

        } catch (error) {
            metrics.errors.inc({ type: 'batch' });
            logger.error('Batch error', { error: String(error) });

            return c.json({
                success: false,
                error: { code: 'INTERNAL_ERROR', message: 'Failed to process batch' },
            }, 500);
        }
    });

    // =====================================
    // Start Server
    // =====================================

    const server = Bun.serve({
        port: config.port,
        hostname: config.host,
        fetch: app.fetch,
    });

    logger.info(`Ingestion Service listening on ${config.host}:${config.port}`, {
        endpoints: [
            '/events',
            '/events/batch',
            '/admin/*',
            '/health',
            '/healthz',
            '/readyz',
            '/metrics'
        ],
    });

    // =====================================
    // Graceful Shutdown
    // =====================================

    const shutdown = async (signal: string) => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        logger.info('Graceful shutdown started', { signal });

        // Stop accepting new requests
        server.stop();

        // Wait for in-flight requests (max 10s)
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Close connections
        await stream.close();
        await redis.quit();

        logger.info('Shutdown complete');
        process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
    console.error('Failed to start service:', error);
    process.exit(1);
});
