/**
 * API Gateway Configuration
 */

export const config = {
    // Server
    port: parseInt(process.env.PORT ?? '8080', 10),
    host: process.env.HOST ?? '0.0.0.0',

    // Redis
    redis: {
        url: process.env.REDIS_URL ?? 'redis://localhost:6379',
    },

    // PostgreSQL
    postgres: {
        url: process.env.POSTGRES_URL ?? 'postgres://postgres:postgres@localhost:5432/esports',
    },

    // Internal services
    services: {
        analytics: process.env.ANALYTICS_URL ?? 'http://localhost:8082',
        predictor: process.env.PREDICTOR_URL ?? 'http://localhost:8083',
    },

    // Rate limiting
    rateLimit: {
        windowMs: 60000, // 1 minute
        maxRequests: parseInt(process.env.RATE_LIMIT ?? '60', 10),
    },

    // Logging
    logLevel: process.env.LOG_LEVEL ?? 'info',
} as const;
