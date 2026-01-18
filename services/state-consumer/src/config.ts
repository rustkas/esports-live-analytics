/**
 * State Consumer Configuration
 */

export const config = {
    // Redis
    redis: {
        url: process.env.REDIS_URL ?? 'redis://localhost:6379',
    },

    // ClickHouse
    clickhouse: {
        url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
        database: process.env.CLICKHOUSE_DATABASE ?? 'esports',
    },

    // Queue
    queue: {
        name: process.env.QUEUE_NAME ?? 'events',
        concurrency: parseInt(process.env.QUEUE_CONCURRENCY ?? '10', 10),
    },

    // Batching for ClickHouse
    batch: {
        size: parseInt(process.env.BATCH_SIZE ?? '100', 10),
        flushIntervalMs: parseInt(process.env.BATCH_FLUSH_INTERVAL ?? '1000', 10),
    },

    // Predictor service
    predictor: {
        url: process.env.PREDICTOR_URL ?? 'http://localhost:8083',
        enabled: process.env.PREDICTOR_ENABLED !== 'false',
    },

    // Logging
    logLevel: process.env.LOG_LEVEL ?? 'info',
} as const;
