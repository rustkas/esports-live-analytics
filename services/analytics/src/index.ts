/**
 * Analytics Service
 * 
 * Provides analytics endpoints for match metrics and statistics.
 * Queries ClickHouse and caches results in Redis.
 * 
 * Endpoints:
 * - GET /matches/:matchId/rounds - Round-by-round metrics
 * - GET /matches/:matchId/metrics - Overall match metrics
 * - GET /matches/:matchId/predictions - Prediction history
 * - GET /matches/:matchId/events - Event counts
 * - GET /health - Health check
 * - GET /metrics - Prometheus metrics
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import Redis from 'ioredis';
import { createLogger, MetricsRegistry } from '@esports/shared';
import { config } from './config';
import { createQueryService } from './queries';

const logger = createLogger('analytics', config.logLevel as 'debug' | 'info');

// Metrics
const registry = new MetricsRegistry();
const queryLatency = registry.createHistogram(
    'analytics_query_latency_ms',
    'Query latency in milliseconds',
    ['query_type'],
    [5, 10, 25, 50, 100, 250, 500]
);
const requestsTotal = registry.createCounter(
    'analytics_requests_total',
    'Total requests',
    ['method', 'path', 'status']
);

async function main() {
    logger.info('Starting Analytics Service', {
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
    const queries = createQueryService();

    // Create Hono app
    const app = new Hono();
    app.use('*', cors());

    // Health check
    app.get('/health', async (c) => {
        return c.json({
            status: 'healthy',
            version: '1.0.0',
            uptime: process.uptime(),
        });
    });

    // Prometheus metrics
    app.get('/metrics', (c) => {
        c.header('Content-Type', 'text/plain; version=0.0.4');
        return c.text(registry.getMetrics());
    });

    // Round metrics
    app.get('/matches/:matchId/maps/:mapId/rounds', async (c) => {
        const { matchId, mapId } = c.req.param();
        const timer = queryLatency.startTimer({ query_type: 'rounds' });

        try {
            // Check cache
            const cacheKey = `analytics:rounds:${matchId}:${mapId}`;
            const cached = await redis.get(cacheKey);

            if (cached) {
                requestsTotal.inc({ method: 'GET', path: '/rounds', status: '200' });
                return c.json({ success: true, data: JSON.parse(cached), cached: true });
            }

            const metrics = await queries.getRoundMetrics(matchId, mapId);

            // Cache result
            await redis.set(cacheKey, JSON.stringify(metrics), 'EX', config.cache.metricsSecond);

            timer();
            requestsTotal.inc({ method: 'GET', path: '/rounds', status: '200' });

            return c.json({ success: true, data: metrics });
        } catch (error) {
            timer();
            requestsTotal.inc({ method: 'GET', path: '/rounds', status: '500' });
            logger.error('Round metrics error', { error: String(error), matchId, mapId });
            return c.json({ success: false, error: 'Query failed' }, 500);
        }
    });

    // Match metrics
    app.get('/matches/:matchId/metrics', async (c) => {
        const matchId = c.req.param('matchId');
        const timer = queryLatency.startTimer({ query_type: 'match_metrics' });

        try {
            const cacheKey = `analytics:match:${matchId}`;
            const cached = await redis.get(cacheKey);

            if (cached) {
                requestsTotal.inc({ method: 'GET', path: '/metrics', status: '200' });
                return c.json({ success: true, data: JSON.parse(cached), cached: true });
            }

            const metrics = await queries.getMatchMetrics(matchId);

            if (!metrics) {
                requestsTotal.inc({ method: 'GET', path: '/metrics', status: '404' });
                return c.json({ success: false, error: 'Match not found' }, 404);
            }

            await redis.set(cacheKey, JSON.stringify(metrics), 'EX', config.cache.metricsSecond);

            timer();
            requestsTotal.inc({ method: 'GET', path: '/metrics', status: '200' });

            return c.json({ success: true, data: metrics });
        } catch (error) {
            timer();
            requestsTotal.inc({ method: 'GET', path: '/metrics', status: '500' });
            logger.error('Match metrics error', { error: String(error), matchId });
            return c.json({ success: false, error: 'Query failed' }, 500);
        }
    });

    // Prediction history
    app.get('/matches/:matchId/maps/:mapId/predictions', async (c) => {
        const { matchId, mapId } = c.req.param();
        const timer = queryLatency.startTimer({ query_type: 'predictions' });

        try {
            const cacheKey = `analytics:predictions:${matchId}:${mapId}`;
            const cached = await redis.get(cacheKey);

            if (cached) {
                requestsTotal.inc({ method: 'GET', path: '/predictions', status: '200' });
                return c.json({ success: true, data: JSON.parse(cached), cached: true });
            }

            const history = await queries.getPredictionHistory(matchId, mapId);

            await redis.set(cacheKey, JSON.stringify(history), 'EX', config.cache.historySeconds);

            timer();
            requestsTotal.inc({ method: 'GET', path: '/predictions', status: '200' });

            return c.json({ success: true, data: history });
        } catch (error) {
            timer();
            requestsTotal.inc({ method: 'GET', path: '/predictions', status: '500' });
            logger.error('Prediction history error', { error: String(error), matchId, mapId });
            return c.json({ success: false, error: 'Query failed' }, 500);
        }
    });

    // Event counts
    app.get('/matches/:matchId/events', async (c) => {
        const matchId = c.req.param('matchId');

        try {
            const counts = await queries.getEventCounts(matchId);
            requestsTotal.inc({ method: 'GET', path: '/events', status: '200' });
            return c.json({ success: true, data: counts });
        } catch (error) {
            requestsTotal.inc({ method: 'GET', path: '/events', status: '500' });
            logger.error('Event counts error', { error: String(error), matchId });
            return c.json({ success: false, error: 'Query failed' }, 500);
        }
    });

    // Start server
    const server = Bun.serve({
        port: config.port,
        hostname: config.host,
        fetch: app.fetch,
    });

    logger.info(`Analytics Service listening on ${config.host}:${config.port}`);

    // Graceful shutdown
    const shutdown = async () => {
        logger.info('Shutting down...');

        server.stop();
        await queries.close();
        await redis.quit();

        logger.info('Shutdown complete');
        process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

main().catch((error) => {
    console.error('Failed to start service:', error);
    process.exit(1);
});
