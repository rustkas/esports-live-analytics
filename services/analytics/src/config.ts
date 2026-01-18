/**
 * Analytics Service Configuration
 */

export const config = {
    // Server
    port: parseInt(process.env.PORT ?? '8082', 10),
    host: process.env.HOST ?? '0.0.0.0',

    // ClickHouse
    clickhouse: {
        url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
        database: process.env.CLICKHOUSE_DATABASE ?? 'esports',
    },

    // Redis (for caching)
    redis: {
        url: process.env.REDIS_URL ?? 'redis://localhost:6379',
    },

    // Cache TTL
    cache: {
        metricsSecond: parseInt(process.env.CACHE_METRICS ?? '5', 10),
        historySeconds: parseInt(process.env.CACHE_HISTORY ?? '60', 10),
    },

    // Logging
    logLevel: process.env.LOG_LEVEL ?? 'info',
} as const;
