/**
 * Ingestion Service Configuration
 */

export const config = {
    // Server
    port: parseInt(process.env.PORT ?? '8081', 10),
    host: process.env.HOST ?? '0.0.0.0',

    // Redis
    redis: {
        url: process.env.REDIS_URL ?? 'redis://localhost:6379',
    },

    // Queue
    queue: {
        name: process.env.QUEUE_NAME ?? 'events',
        concurrency: parseInt(process.env.QUEUE_CONCURRENCY ?? '10', 10),
        attempts: parseInt(process.env.QUEUE_ATTEMPTS ?? '3', 10),
        backoffDelay: parseInt(process.env.QUEUE_BACKOFF_DELAY ?? '1000', 10),
    },

    // Deduplication
    dedup: {
        enabled: process.env.DEDUP_ENABLED !== 'false',
        ttlSeconds: parseInt(process.env.DEDUP_TTL ?? '3600', 10),
    },

    // Logging
    logLevel: process.env.LOG_LEVEL ?? 'info',

    // Metrics
    metricsEnabled: process.env.METRICS_ENABLED !== 'false',
} as const;

export type Config = typeof config;
