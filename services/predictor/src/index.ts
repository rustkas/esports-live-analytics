/**
 * Predictor Service
 * 
 * Calculates win probabilities for live CS2 matches.
 * Uses a rule-based model (to be replaced with ML in production).
 * 
 * Endpoints:
 * - POST /predict - Calculate prediction for given match state
 * - GET /prediction/:matchId - Get latest prediction
 * - GET /health - Health check
 * - GET /metrics - Prometheus metrics
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import Redis from 'ioredis';
import type { MatchState, PredictRequest } from '@esports/shared';
import { createLogger } from '@esports/shared';
import { config } from './config';
import { createPredictionModel } from './model';
import { createPredictionStorage } from './storage';
import * as metrics from './metrics';

const logger = createLogger('predictor', config.logLevel as 'debug' | 'info');

async function main() {
    logger.info('Starting Predictor Service', {
        port: config.port,
        model_version: config.model.version,
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

    // Create Hono app
    const app = new Hono();
    app.use('*', cors());

    // Health check
    app.get('/health', (c) => {
        return c.json({
            status: 'healthy',
            version: '1.0.0',
            model_version: config.model.version,
            uptime: process.uptime(),
        });
    });

    // Prometheus metrics
    app.get('/metrics', (c) => {
        c.header('Content-Type', 'text/plain; version=0.0.4');
        return c.text(metrics.registry.metrics());
    });

    // Calculate prediction
    app.post('/predict', async (c) => {
        const startTime = performance.now();

        try {
            const body = await c.req.json() as PredictRequest;

            if (!body.state) {
                metrics.requestsTotal.inc({ method: 'POST', path: '/predict', status: '400' });
                return c.json({ success: false, error: 'Missing state' }, 400);
            }

            const state = body.state;

            // Calculate prediction
            const prediction = model.predict(
                state,
                body.trigger_event_id,
                body.trigger_event_type
            );

            // Save and publish
            await Promise.all([
                storage.save(prediction),
                storage.publish(prediction),
            ]);

            const latencyMs = performance.now() - startTime;

            metrics.predictionsTotal.inc({ trigger_type: body.trigger_event_type ?? 'manual' });
            metrics.predictionLatency.observe(latencyMs);
            metrics.requestsTotal.inc({ method: 'POST', path: '/predict', status: '200' });

            logger.info('Prediction calculated', {
                match_id: prediction.match_id,
                p_a: prediction.p_team_a_win,
                p_b: prediction.p_team_b_win,
                confidence: prediction.confidence,
                latency_ms: latencyMs.toFixed(2),
            });

            return c.json({
                success: true,
                prediction,
                latency_ms: latencyMs,
            });

        } catch (error) {
            metrics.errorsTotal.inc({ type: 'prediction' });
            metrics.requestsTotal.inc({ method: 'POST', path: '/predict', status: '500' });
            logger.error('Prediction error', { error: String(error) });

            return c.json({ success: false, error: 'Prediction failed' }, 500);
        }
    });

    // Get latest prediction
    app.get('/prediction/:matchId', async (c) => {
        const matchId = c.req.param('matchId');

        try {
            const prediction = await storage.getLatest(matchId);

            if (!prediction) {
                metrics.requestsTotal.inc({ method: 'GET', path: '/prediction', status: '404' });
                return c.json({ success: false, error: 'No prediction found' }, 404);
            }

            metrics.requestsTotal.inc({ method: 'GET', path: '/prediction', status: '200' });

            return c.json({
                success: true,
                prediction,
            });

        } catch (error) {
            metrics.errorsTotal.inc({ type: 'get_prediction' });
            metrics.requestsTotal.inc({ method: 'GET', path: '/prediction', status: '500' });
            logger.error('Get prediction error', { error: String(error), matchId });

            return c.json({ success: false, error: 'Failed to get prediction' }, 500);
        }
    });

    // Model info
    app.get('/model', (c) => {
        return c.json({
            version: config.model.version,
            type: 'rule-based',
            weights: config.model.weights,
        });
    });

    // Start server
    const server = Bun.serve({
        port: config.port,
        hostname: config.host,
        fetch: app.fetch,
    });

    logger.info(`Predictor Service listening on ${config.host}:${config.port}`);

    // Graceful shutdown
    const shutdown = async () => {
        logger.info('Shutting down...');

        server.stop();
        await storage.close();
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
