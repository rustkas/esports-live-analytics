/**
 * Predictor Service
 * 
 * Calculates win probabilities for live CS2 matches.
 * 
 * Features:
 * - Rule-based prediction model (v1.0.0)
 * - Prediction storage in Redis
 * - Pub/Sub for real-time updates
 * - Predictor latency metrics
 * - Health checks (/healthz, /readyz)
 * - Graceful shutdown
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import Redis from 'ioredis';
import type { MatchState, PredictRequest } from '@esports/shared';
import {
    createLogger,
    createHealthChecks,
    createProductionMetrics,
} from '@esports/shared';
import { config } from './config';
import { createPredictionModel } from './model';
import { createPredictionStorage } from './storage';

const logger = createLogger('predictor', config.logLevel as 'debug' | 'info');
const metrics = createProductionMetrics('predictor');
const SERVICE_VERSION = '1.0.0';
const MODEL_VERSION = config.model.version;

// Shutdown state
let isShuttingDown = false;

async function main() {
    logger.info('Starting Predictor Service', {
        version: SERVICE_VERSION,
        model_version: MODEL_VERSION,
        port: config.port,
    });

    // Connect to Redis
    const redis = new Redis(config.redis.url, {
        lazyConnect: true,
    });

    redis.on('error', (err) => {
        logger.error('Redis connection error', { error: String(err) });
    });

    await redis.connect();
    logger.info('Connected to Redis');

    // Initialize components
    const model = createPredictionModel();
    const storage = createPredictionStorage(redis);

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
    ]);

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

        const path = c.req.path.split('/').slice(0, 2).join('/') || '/';
        metrics.requests.inc({
            method: c.req.method,
            path,
            status: String(c.res.status),
        });
        metrics.requestLatency.observe(latency, { method: c.req.method, path });
    });

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
        return c.json({
            ...result.body as object,
            model_version: MODEL_VERSION,
        }, result.status as 200 | 503);
    });

    // =====================================
    // Metrics
    // =====================================

    app.get('/metrics', (c) => {
        c.header('Content-Type', 'text/plain; version=0.0.4');
        return c.text(metrics.registry.getMetrics());
    });

    // =====================================
    // Prediction Endpoint
    // =====================================

    app.post('/predict', async (c) => {
        const startTime = performance.now();

        try {
            const body = await c.req.json() as PredictRequest & {
                trace_id?: string;
            };

            if (!body.state) {
                metrics.errors.inc({ type: 'validation' });
                return c.json({ success: false, error: 'Missing state' }, 400);
            }

            const state = body.state;
            const logContext = {
                trace_id: body.trace_id,
                match_id: state.match_id,
                map_id: state.map_id,
                trigger_type: body.trigger_event_type ?? 'manual',
            };

            // Calculate prediction
            const predictStart = performance.now();
            const prediction = await model.predict(
                state,
                body.trigger_event_id,
                body.trigger_event_type
            );
            const predictLatency = performance.now() - predictStart;

            // Track predictor-specific latency
            metrics.predictorLatency.observe(predictLatency, { model_version: MODEL_VERSION });

            // Save and publish
            const pubStart = performance.now();
            await Promise.all([
                storage.save(prediction),
                storage.publish(prediction),
            ]);
            const pubLatency = performance.now() - pubStart;

            metrics.recordStage('predict', predictLatency);
            metrics.recordStage('publish', pubLatency);

            const totalLatency = performance.now() - startTime;
            metrics.eventsProcessed.inc({ type: body.trigger_event_type ?? 'manual' });

            logger.info('Prediction calculated', {
                ...logContext,
                p_team_a_win: prediction.p_team_a_win.toFixed(3),
                p_team_b_win: prediction.p_team_b_win.toFixed(3),
                confidence: prediction.confidence.toFixed(3),
                predict_latency_ms: predictLatency.toFixed(2),
                total_latency_ms: totalLatency.toFixed(2),
            });

            return c.json({
                success: true,
                prediction: {
                    match_id: prediction.match_id,
                    map_id: prediction.map_id,
                    round_no: prediction.round_no,
                    p_team_a_win: prediction.p_team_a_win,
                    p_team_b_win: prediction.p_team_b_win,
                    confidence: prediction.confidence,
                    model_version: prediction.model_version,
                    ts_calc: prediction.ts_calc,
                },
                latency_ms: totalLatency,
            });

        } catch (error) {
            metrics.errors.inc({ type: 'prediction' });
            logger.error('Prediction failed', { error: String(error) });

            return c.json({
                success: false,
                error: 'Prediction failed',
            }, 500);
        }
    });

    // =====================================
    // Get Latest Prediction
    // =====================================

    app.get('/prediction/:matchId', async (c) => {
        try {
            const matchId = c.req.param('matchId');
            const prediction = await storage.getLatest(matchId);

            if (!prediction) {
                return c.json({
                    success: false,
                    error: 'No prediction found',
                }, 404);
            }

            return c.json({
                success: true,
                prediction,
            });

        } catch (error) {
            logger.error('Get prediction failed', { error: String(error) });
            return c.json({ success: false, error: 'Failed to get prediction' }, 500);
        }
    });

    // =====================================
    // Prediction History
    // =====================================

    app.get('/prediction/:matchId/history', async (c) => {
        try {
            const matchId = c.req.param('matchId');
            const limit = parseInt(c.req.query('limit') ?? '50', 10);
            const history = await storage.getHistory(matchId, Math.min(limit, 100));

            return c.json({
                success: true,
                match_id: matchId,
                count: history.length,
                predictions: history,
            });

        } catch (error) {
            logger.error('Get history failed', { error: String(error) });
            return c.json({ success: false, error: 'Failed to get history' }, 500);
        }
    });

    // =====================================
    // Start Server
    // =====================================

    const server = Bun.serve({
        port: config.port,
        hostname: config.host,
        fetch: app.fetch,
    });

    logger.info(`Predictor Service listening on ${config.host}:${config.port}`, {
        model_version: MODEL_VERSION,
        endpoints: ['/predict', '/prediction/:matchId', '/health', '/healthz', '/readyz', '/metrics'],
    });

    // =====================================
    // Graceful Shutdown
    // =====================================

    const shutdown = async (signal: string) => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        logger.info('Graceful shutdown started', { signal });

        server.stop();
        await new Promise(resolve => setTimeout(resolve, 1000));
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
