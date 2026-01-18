/**
 * API Gateway Service
 * 
 * Central API gateway providing:
 * - REST API at /api/*
 * - GraphQL at /graphql
 * - WebSocket subscriptions
 * - Health checks at /health
 * - Prometheus metrics at /metrics
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createYoga } from 'graphql-yoga';
import { makeExecutableSchema } from '@graphql-tools/schema';
import Redis from 'ioredis';
import { createLogger, MetricsRegistry } from '@esports/shared';
import { config } from './config';
import { createDatabase } from './database';
import { typeDefs } from './schema';
import { createResolvers } from './resolvers';
import { createRestRoutes } from './rest';

const logger = createLogger('api-gateway', config.logLevel as 'debug' | 'info');

// Metrics
const registry = new MetricsRegistry();
const requestsTotal = registry.createCounter(
    'api_gateway_requests_total',
    'Total requests',
    ['method', 'path', 'status']
);
const requestLatency = registry.createHistogram(
    'api_gateway_request_latency_ms',
    'Request latency in milliseconds',
    ['method', 'path'],
    [5, 10, 25, 50, 100, 250, 500, 1000]
);

async function main() {
    logger.info('Starting API Gateway', {
        port: config.port,
    });

    // Connect to Redis
    const redis = new Redis(config.redis.url, {
        lazyConnect: true,
    });

    await redis.connect();
    logger.info('Connected to Redis');

    // Connect to PostgreSQL
    const db = createDatabase();

    // Test database connection
    await db.query('SELECT 1');
    logger.info('Connected to PostgreSQL');

    // Create GraphQL schema
    const schema = makeExecutableSchema({
        typeDefs,
        resolvers: createResolvers({ db, redis }),
    });

    // Create Yoga GraphQL server
    const yoga = createYoga({
        schema,
        graphqlEndpoint: '/graphql',
        landingPage: true,
        graphiql: {
            title: 'CS2 Analytics GraphQL',
        },
    });

    // Create Hono app
    const app = new Hono();

    // Middleware
    app.use('*', cors());

    // Request logging and metrics middleware
    app.use('*', async (c, next) => {
        const start = performance.now();
        await next();
        const latency = performance.now() - start;

        const path = c.req.path.split('/').slice(0, 3).join('/'); // Normalize path
        requestsTotal.inc({
            method: c.req.method,
            path,
            status: String(c.res.status),
        });
        requestLatency.observe(latency, { method: c.req.method, path });
    });

    // Health check
    app.get('/health', async (c) => {
        const checks: Array<{ name: string; status: string }> = [];

        // Check Redis
        try {
            await redis.ping();
            checks.push({ name: 'redis', status: 'pass' });
        } catch {
            checks.push({ name: 'redis', status: 'fail' });
        }

        // Check PostgreSQL
        try {
            await db.query('SELECT 1');
            checks.push({ name: 'postgres', status: 'pass' });
        } catch {
            checks.push({ name: 'postgres', status: 'fail' });
        }

        const allPass = checks.every(check => check.status === 'pass');

        return c.json({
            status: allPass ? 'healthy' : 'degraded',
            version: '1.0.0',
            uptime: process.uptime(),
            checks,
        }, allPass ? 200 : 503);
    });

    // Prometheus metrics
    app.get('/metrics', (c) => {
        c.header('Content-Type', 'text/plain; version=0.0.4');
        return c.text(registry.getMetrics());
    });

    // REST API routes
    const restRoutes = createRestRoutes(db, redis);
    app.route('/api', restRoutes);

    // GraphQL endpoint
    app.on(['GET', 'POST'], '/graphql', async (c) => {
        const response = await yoga.fetch(c.req.raw, {
            db,
            redis,
        });
        return new Response(response.body, {
            status: response.status,
            headers: response.headers,
        });
    });

    // Start server using native Bun API
    const server = Bun.serve({
        port: config.port,
        hostname: config.host,
        fetch: app.fetch,
    });

    logger.info(`API Gateway listening on ${config.host}:${config.port}`);
    logger.info('Endpoints:');
    logger.info(`  - REST API: http://localhost:${config.port}/api`);
    logger.info(`  - GraphQL: http://localhost:${config.port}/graphql`);
    logger.info(`  - Health: http://localhost:${config.port}/health`);
    logger.info(`  - Metrics: http://localhost:${config.port}/metrics`);

    // Graceful shutdown
    const shutdown = async () => {
        logger.info('Shutting down...');

        server.stop();
        await db.end();
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
