export const config = {
    port: parseInt(process.env.PORT ?? '8084', 10),
    match_port: parseInt(process.env.MATCH_PORT ?? '8085', 10), // If separate
    redis: {
        url: process.env.REDIS_URL ?? 'redis://localhost:6379'
    },
    logLevel: process.env.LOG_LEVEL ?? 'info'
};
