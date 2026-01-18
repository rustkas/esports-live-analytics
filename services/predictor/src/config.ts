/**
 * Predictor Service Configuration
 */

export const config = {
    // Server
    port: parseInt(process.env.PORT ?? '8083', 10),
    host: process.env.HOST ?? '0.0.0.0',

    // Redis
    redis: {
        url: process.env.REDIS_URL ?? 'redis://localhost:6379',
    },

    // ClickHouse
    clickhouse: {
        url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
        database: process.env.CLICKHOUSE_DATABASE ?? 'esports',
    },

    // Model
    model: {
        version: process.env.MODEL_VERSION ?? 'v1.0.0-rule-based',
        // Weights for the rule-based model
        weights: {
            score: parseFloat(process.env.WEIGHT_SCORE ?? '0.4'),
            momentum: parseFloat(process.env.WEIGHT_MOMENTUM ?? '0.25'),
            economy: parseFloat(process.env.WEIGHT_ECONOMY ?? '0.2'),
            alive: parseFloat(process.env.WEIGHT_ALIVE ?? '0.15'),
        },
    },

    // Cache
    cache: {
        ttlSeconds: parseInt(process.env.CACHE_TTL ?? '5', 10),
    },

    // Logging
    logLevel: process.env.LOG_LEVEL ?? 'info',
} as const;
