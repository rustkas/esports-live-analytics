/**
 * Analytics Service
 * 
 * Provides analytics endpoints for match metrics and statistics.
 * Queries ClickHouse and caches results in Redis.
 * 
 * Features:
 * - ClickHouse queries with Redis caching
 * - Query latency metrics
 * - Health checks (/healthz, /readyz)
 * - Graceful shutdown
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import Redis from 'ioredis';
import {
    createLogger,
    createHealthChecks,
    createProductionMetrics,
} from '@esports/shared';
import { config } from './config';
import { createQueryService } from './queries';
import { createCachedQueryService } from './cache';

const logger = createLogger('analytics', config.logLevel as 'debug' | 'info');
const metrics = createProductionMetrics('analytics');
const SERVICE_VERSION = '1.0.0';

// Shutdown state
let isShuttingDown = false;

async function main() {
    logger.info('Starting Analytics Service', {
        version: SERVICE_VERSION,
        port: config.port,
        clickhouse: config.clickhouse.url,
    });

    // Connect to Redis
    const redis = new Redis(config.redis.url, {
        lazyConnect: true,
    });

    await redis.connect();
    logger.info('Connected to Redis');

    // Initialize query service
    const baseQueries = createQueryService();
    const queries = createCachedQueryService(baseQueries, redis);

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
            check: async () => queries.healthCheck(),
        },
    ]);

    // Create Hono app
    const app = new Hono();
    app.use('*', cors());

    // Request middleware
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
    // Metrics
    // =====================================

    app.get('/metrics', (c) => {
        c.header('Content-Type', 'text/plain; version=0.0.4');
        return c.text(metrics.registry.getMetrics());
    });

    // =====================================
    // Analytics Endpoints
    // =====================================

    // Round metrics
    app.get('/matches/:matchId/maps/:mapId/rounds', async (c) => {
        const { matchId, mapId } = c.req.param();
        const startTime = performance.now();

        try {
            // Check cache
            const cacheKey = `analytics:rounds:${matchId}:${mapId}`;
            const cached = await redis.get(cacheKey);

            if (cached) {
                return c.json({ success: true, data: JSON.parse(cached), cached: true });
            }

            const data = await queries.getRoundMetrics(matchId, mapId);
            const latency = performance.now() - startTime;

            // Cache result
            await redis.set(cacheKey, JSON.stringify(data), 'EX', config.cache.metricsSecond);

            metrics.recordStage('query_rounds', latency);

            return c.json({ success: true, data });
        } catch (error) {
            metrics.errors.inc({ type: 'query_rounds' });
            logger.error('Query rounds failed', { matchId, mapId, error: String(error) });
            return c.json({ success: false, error: 'Query failed' }, 500);
        }
    });

    // Match metrics
    app.get('/matches/:matchId/maps/:mapId/metrics', async (c) => {
        const { matchId, mapId } = c.req.param();
        const startTime = performance.now();

        try {
            const cacheKey = `analytics:metrics:${matchId}:${mapId}`;
            const cached = await redis.get(cacheKey);

            if (cached) {
                return c.json({ success: true, data: JSON.parse(cached), cached: true });
            }

            const data = await queries.getMatchMetrics(matchId, mapId);
            const latency = performance.now() - startTime;

            await redis.set(cacheKey, JSON.stringify(data), 'EX', config.cache.metricsSecond);

            metrics.recordStage('query_metrics', latency);

            return c.json({ success: true, data });
        } catch (error) {
            metrics.errors.inc({ type: 'query_metrics' });
            logger.error('Query metrics failed', { matchId, mapId, error: String(error) });
            return c.json({ success: false, error: 'Query failed' }, 500);
        }
    });

    // Player stats
    app.get('/matches/:matchId/maps/:mapId/players', async (c) => {
        const { matchId, mapId } = c.req.param();
        const startTime = performance.now();

        try {
            const cacheKey = `analytics:players:${matchId}:${mapId}`;
            const cached = await redis.get(cacheKey);

            if (cached) {
                return c.json({ success: true, data: JSON.parse(cached), cached: true });
            }

            const data = await queries.getPlayerStats(matchId, mapId);
            const latency = performance.now() - startTime;

            await redis.set(cacheKey, JSON.stringify(data), 'EX', config.cache.metricsSecond);

            metrics.recordStage('query_players', latency);

            return c.json({ success: true, data });
        } catch (error) {
            metrics.errors.inc({ type: 'query_players' });
            logger.error('Query players failed', { matchId, mapId, error: String(error) });
            return c.json({ success: false, error: 'Query failed' }, 500);
        }
    });

    // Predictions history
    app.get('/matches/:matchId/maps/:mapId/predictions', async (c) => {
        const { matchId, mapId } = c.req.param();
        const startTime = performance.now();

        try {
            const data = await queries.getPredictionHistory(matchId, mapId);
            const latency = performance.now() - startTime;

            metrics.recordStage('query_predictions', latency);

            return c.json({ success: true, data });
        } catch (error) {
            metrics.errors.inc({ type: 'query_predictions' });
            logger.error('Query predictions failed', { matchId, mapId, error: String(error) });
            return c.json({ success: false, error: 'Query failed' }, 500);
        }
    });

    // Event counts
    app.get('/matches/:matchId/maps/:mapId/events', async (c) => {
        const { matchId, mapId } = c.req.param();
        const startTime = performance.now();

        try {
            const data = await queries.getEventCounts(matchId, mapId);
            const latency = performance.now() - startTime;

            metrics.recordStage('query_events', latency);

            return c.json({ success: true, data });
        } catch (error) {
            metrics.errors.inc({ type: 'query_events' });
            logger.error('Query events failed', { matchId, mapId, error: String(error) });
            return c.json({ success: false, error: 'Query failed' }, 500);
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

    logger.info(`Analytics Service listening on ${config.host}:${config.port}`, {
        endpoints: ['/matches', '/health', '/healthz', '/readyz', '/metrics'],
    });

    // =====================================
    // Graceful Shutdown
    // =====================================

    const shutdown = async (signal: string) => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        logger.info('Graceful shutdown started', { signal });

        server.stop();
        await new Promise(resolve => setTimeout(resolve, 1000));
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
