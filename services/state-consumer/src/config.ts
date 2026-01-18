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

    // Consumer settings (Redis Streams)
    consumer: {
        batchSize: parseInt(process.env.CONSUMER_BATCH_SIZE ?? '10', 10),
        blockMs: parseInt(process.env.CONSUMER_BLOCK_MS ?? '2000', 10),
        discoveryIntervalMs: parseInt(process.env.DISCOVERY_INTERVAL_MS ?? '5000', 10),
    },

    // Legacy compatibility alias
    queue: {
        name: 'events', // Not used, kept for compatibility
        concurrency: parseInt(process.env.CONSUMER_BATCH_SIZE ?? '10', 10),
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

    // Metrics server
    metrics: {
        port: parseInt(process.env.METRICS_PORT ?? '8090', 10),
    },

    // Logging
    logLevel: process.env.LOG_LEVEL ?? 'info',
} as const;
