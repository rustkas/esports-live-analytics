/**
 * API Gateway Service
 * 
 * Central API gateway providing:
 * - REST API at /api/*
 * - GraphQL at /graphql
 * - Health checks at /health, /healthz, /readyz
 * - Prometheus metrics at /metrics
 * 
 * Features:
 * - Request tracking with metrics
 * - B2B Security (Auth, Rate Limit, Audit)
 * - Graceful shutdown
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createYoga } from 'graphql-yoga';
import { makeExecutableSchema } from '@graphql-tools/schema';
import Redis from 'ioredis';
import {
    createLogger,
    createHealthChecks,
    createProductionMetrics,
} from '@esports/shared';
import { config } from './config';
import { createDatabase } from './database';
import { typeDefs } from './schema';
import { createResolvers } from './resolvers';
import { createRestRoutes } from './rest';
import { createSecurityService, createAuthMiddleware } from './security';

const logger = createLogger('api-gateway', config.logLevel as 'debug' | 'info');
const metrics = createProductionMetrics('api_gateway');
const SERVICE_VERSION = '1.0.0';

// Shutdown state
let isShuttingDown = false;

async function main() {
    logger.info('Starting API Gateway', {
        version: SERVICE_VERSION,
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

    await db.query('SELECT 1');
    logger.info('Connected to PostgreSQL');

    // Initialize Security Service
    const security = createSecurityService(redis, db);

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
            name: 'postgres',
            check: async () => {
                try {
                    await db.query('SELECT 1');
                    return true;
                } catch {
                    return false;
                }
            },
        },
    ]);

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
    // Security Middleware
    // =====================================

    // Protect all API routes (except public/health)
    app.use('/api/*', createAuthMiddleware(security));

    // Protect GraphQL
    // app.use('/graphql', createAuthMiddleware(security)); // Optional: disable for now if needed

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

    // Public Status Page
    app.get('/status', (c) => c.json({
        status: 'operational',
        version: SERVICE_VERSION,
        timestamp: new Date().toISOString()
    }));

    // Start Webhook Service
    const { createWebhookService } = await import('./webhooks');
    const webhooks = createWebhookService(redis, db);
    webhooks.start().catch(err => logger.error('Webhook start failed', { error: String(err) }));

    // =====================================
    // REST API
    // =====================================

    const { createFeatureFlagService } = await import('./flags');
    const flags = createFeatureFlagService(redis, db);

    const restRoutes = createRestRoutes(db, redis, flags);
    app.route('/api/v1', restRoutes);

    // =====================================
    // GraphQL
    // =====================================

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

    // =====================================
    // Start Server
    // =====================================

    const server = Bun.serve({
        port: config.port,
        hostname: config.host,
        fetch: app.fetch,
    });

    logger.info(`API Gateway listening on ${config.host}:${config.port}`, {
        endpoints: [
            'REST: /api/*',
            'GraphQL: /graphql',
            'Health: /health, /healthz, /readyz',
            'Metrics: /metrics',
        ],
        security: 'enabled',
    });

    // =====================================
    // Graceful Shutdown
    // =====================================

    const shutdown = async (signal: string) => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        logger.info('Graceful shutdown started', { signal });

        server.stop();

        // Flush audit logs
        await security.auditLogger.flush();

        // Wait for in-flight requests
        await new Promise(resolve => setTimeout(resolve, 2000));

        await db.end();
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
