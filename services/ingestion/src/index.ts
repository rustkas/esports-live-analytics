/**
 * Ingestion Service
 * 
 * HTTP intake for CS2 game events.
 * Validates events, deduplicates, and publishes to Redis Streams.
 * 
 * Uses Redis Streams for strict ordering guarantees per shard.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import Redis from 'ioredis';
import { createLogger } from '@esports/shared';
import { config } from './config';
import { createRoutes } from './routes';
import { createStreamPublisher } from './stream';
import { createDedupService } from './dedup';

const logger = createLogger('ingestion', config.logLevel as 'debug' | 'info');

async function main() {
    logger.info('Starting Ingestion Service (Redis Streams mode)', {
        port: config.port,
        redis: config.redis.url,
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

    const dedup = createDedupService(redis);

    logger.info('Stream publisher and dedup service initialized');

    // Create Hono app
    const app = new Hono();
    app.use('*', cors());

    // Mount routes
    const routes = createRoutes({ stream, dedup });
    app.route('/', routes);

    // Start server
    const server = Bun.serve({
        port: config.port,
        hostname: config.host,
        fetch: app.fetch,
    });

    logger.info(`Ingestion Service listening on ${config.host}:${config.port}`);
    logger.info('Mode: Redis Streams (strict ordering per shard)');

    // Graceful shutdown
    const shutdown = async () => {
        logger.info('Shutting down...');

        server.stop();
        await stream.close();
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
