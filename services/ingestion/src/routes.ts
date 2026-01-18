/**
 * Ingestion API Routes
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { BaseEventSchema, validateEvent, createLogger } from '@esports/shared';
import type { QueueManager } from './queue';
import type { DedupService } from './dedup';
import * as metrics from './metrics';
import { config } from './config';

const logger = createLogger('ingestion:routes', config.logLevel as 'debug' | 'info');

interface RouteDeps {
    queue: QueueManager;
    dedup: DedupService;
}

export function createRoutes(deps: RouteDeps): Hono {
    const app = new Hono();
    const { queue, dedup } = deps;

    // Health check
    app.get('/health', async (c) => {
        try {
            const stats = await queue.getStats();
            return c.json({
                status: 'healthy',
                version: '1.0.0',
                uptime: process.uptime(),
                queue: stats,
            });
        } catch (error) {
            return c.json({ status: 'unhealthy', error: String(error) }, 503);
        }
    });

    // Prometheus metrics
    app.get('/metrics', (c) => {
        c.header('Content-Type', 'text/plain; version=0.0.4');
        return c.text(metrics.registry.getMetrics());
    });

    // Single event ingestion
    app.post('/events', async (c) => {
        const startTime = performance.now();

        try {
            const body = await c.req.json();

            // Validate event
            const validation = validateEvent(body);
            if (!validation.success) {
                metrics.eventsInvalid.inc({ reason: 'validation' });
                return c.json(
                    {
                        success: false,
                        error: {
                            code: 'VALIDATION_ERROR',
                            message: 'Invalid event format',
                            details: validation.error.errors,
                        },
                    },
                    400
                );
            }

            const event = validation.data;

            // Add ingest timestamp
            event.ts_ingest = new Date().toISOString();

            // Track received
            metrics.eventsReceived.inc({ type: event.type, source: event.source });

            // Check for duplicates
            if (await dedup.isDuplicate(event.event_id)) {
                metrics.eventsDuplicate.inc();
                return c.json(
                    {
                        success: true,
                        message: 'Event already processed',
                        event_id: event.event_id,
                        duplicate: true,
                    },
                    200
                );
            }

            // Enqueue
            const jobId = await queue.enqueue(event);

            // Mark as seen
            await dedup.markSeen(event.event_id);

            // Track success
            metrics.eventsProcessed.inc({ type: event.type });

            const latency = performance.now() - startTime;
            metrics.processingLatency.observe(latency, { type: event.type });

            logger.info('Event ingested', {
                event_id: event.event_id,
                type: event.type,
                match_id: event.match_id,
                latency_ms: latency.toFixed(2),
            });

            return c.json({
                success: true,
                event_id: event.event_id,
                job_id: jobId,
                latency_ms: latency,
            });

        } catch (error) {
            metrics.errorsTotal.inc({ type: 'ingestion' });
            logger.error('Ingestion error', { error: String(error) });

            return c.json(
                {
                    success: false,
                    error: {
                        code: 'INTERNAL_ERROR',
                        message: 'Failed to process event',
                    },
                },
                500
            );
        }
    });

    // Batch event ingestion
    app.post('/events/batch', async (c) => {
        const startTime = performance.now();

        try {
            const body = await c.req.json();

            if (!Array.isArray(body)) {
                return c.json(
                    {
                        success: false,
                        error: {
                            code: 'VALIDATION_ERROR',
                            message: 'Expected array of events',
                        },
                    },
                    400
                );
            }

            if (body.length > 100) {
                return c.json(
                    {
                        success: false,
                        error: {
                            code: 'BATCH_TOO_LARGE',
                            message: 'Maximum batch size is 100 events',
                        },
                    },
                    400
                );
            }

            metrics.batchSize.observe(body.length);

            const results: Array<{
                event_id: string;
                success: boolean;
                duplicate?: boolean;
                error?: string;
            }> = [];

            let processed = 0;
            let duplicates = 0;
            let errors = 0;

            for (const item of body) {
                const validation = validateEvent(item);

                if (!validation.success) {
                    errors++;
                    results.push({
                        event_id: item.event_id ?? 'unknown',
                        success: false,
                        error: 'Validation failed',
                    });
                    continue;
                }

                const event = validation.data;
                event.ts_ingest = new Date().toISOString();

                metrics.eventsReceived.inc({ type: event.type, source: event.source });

                if (await dedup.isDuplicate(event.event_id)) {
                    duplicates++;
                    results.push({
                        event_id: event.event_id,
                        success: true,
                        duplicate: true,
                    });
                    continue;
                }

                try {
                    await queue.enqueue(event);
                    await dedup.markSeen(event.event_id);

                    processed++;
                    metrics.eventsProcessed.inc({ type: event.type });

                    results.push({
                        event_id: event.event_id,
                        success: true,
                    });
                } catch (err) {
                    errors++;
                    results.push({
                        event_id: event.event_id,
                        success: false,
                        error: 'Queue error',
                    });
                }
            }

            const latency = performance.now() - startTime;

            logger.info('Batch ingested', {
                total: body.length,
                processed,
                duplicates,
                errors,
                latency_ms: latency.toFixed(2),
            });

            return c.json({
                success: true,
                total: body.length,
                processed,
                duplicates,
                errors,
                results,
                latency_ms: latency,
            });

        } catch (error) {
            metrics.errorsTotal.inc({ type: 'batch_ingestion' });
            logger.error('Batch ingestion error', { error: String(error) });

            return c.json(
                {
                    success: false,
                    error: {
                        code: 'INTERNAL_ERROR',
                        message: 'Failed to process batch',
                    },
                },
                500
            );
        }
    });

    // Queue stats
    app.get('/stats', async (c) => {
        const stats = await queue.getStats();
        return c.json(stats);
    });

    return app;
}
