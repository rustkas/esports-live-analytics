/**
 * Ingestion Service
 * 
 * Receives live CS2 match events via HTTP, validates them,
 * deduplicates using Redis, and queues them for processing.
 * 
 * Endpoints:
 * - POST /events - Single event ingestion
 * - POST /events/batch - Batch ingestion (up to 100 events)
 * - GET /health - Health check
 * - GET /metrics - Prometheus metrics
 * - GET /stats - Queue statistics
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import Redis from 'ioredis';
import { createLogger } from '@esports/shared';
import { config } from './config';
import { createQueueManager } from './queue';
import { createDedupService } from './dedup';
import { createRoutes } from './routes';

const logger = createLogger('ingestion', config.logLevel as 'debug' | 'info');

async function main() {
    logger.info('Starting Ingestion Service', {
        port: config.port,
        redis: config.redis.url,
    });

    // Connect to Redis
    const redis = new Redis(config.redis.url, {
        maxRetriesPerRequest: null, // Required for BullMQ
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

    // Initialize services
    const queue = createQueueManager(redis);
    const dedup = createDedupService(redis);

    // Create Hono app
    const app = new Hono();

    // Middleware
    app.use('*', cors());

    if (process.env.NODE_ENV !== 'production') {
        app.use('*', honoLogger());
    }

    // Mount routes
    const routes = createRoutes({ queue, dedup });
    app.route('/', routes);

    // Start server
    const server = Bun.serve({
        port: config.port,
        hostname: config.host,
        fetch: app.fetch,
    });

    logger.info(`Ingestion Service listening on ${config.host}:${config.port}`);

    // Graceful shutdown
    const shutdown = async () => {
        logger.info('Shutting down...');

        server.stop();
        await queue.close();
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
