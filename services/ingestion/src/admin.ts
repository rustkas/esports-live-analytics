/**
 * Admin API for DLQ Management
 * 
 * Provides endpoints for:
 * - Viewing DLQ entries
 * - Requeuing events
 * - DLQ statistics
 */

import { Hono } from 'hono';
import type { DLQManager } from '@esports/shared';
import { createLogger } from '@esports/shared';

const logger = createLogger('admin:dlq');

export function createAdminRoutes(dlq: DLQManager): Hono {
    const app = new Hono();

    // Get DLQ stats
    app.get('/dlq/stats', async (c) => {
        try {
            const stats = await dlq.getStats();
            return c.json({
                success: true,
                data: stats,
            });
        } catch (error) {
            logger.error('Failed to get DLQ stats', { error: String(error) });
            return c.json({ success: false, error: 'Failed to get stats' }, 500);
        }
    });

    // List DLQ shards
    app.get('/dlq/shards', async (c) => {
        try {
            const shards = await dlq.getDLQShards();
            const stats = await dlq.getStats();

            return c.json({
                success: true,
                data: {
                    shards,
                    counts: stats.byShardCounts,
                },
            });
        } catch (error) {
            logger.error('Failed to get DLQ shards', { error: String(error) });
            return c.json({ success: false, error: 'Failed to get shards' }, 500);
        }
    });

    // Get DLQ entries for a shard
    app.get('/dlq/shards/:shard', async (c) => {
        try {
            const shard = c.req.param('shard');
            const limit = parseInt(c.req.query('limit') ?? '100', 10);

            const entries = await dlq.getDLQEntries(shard, Math.min(limit, 1000));

            return c.json({
                success: true,
                data: {
                    shard,
                    count: entries.length,
                    entries: entries.map(e => ({
                        id: e.id,
                        event_id: e.event.event_id,
                        type: e.event.type,
                        match_id: e.event.match_id,
                        error: e.error,
                        retry_count: e.retryCount,
                        first_failed_at: e.firstFailedAt,
                        last_failed_at: e.lastFailedAt,
                    })),
                },
            });
        } catch (error) {
            logger.error('Failed to get DLQ entries', { error: String(error) });
            return c.json({ success: false, error: 'Failed to get entries' }, 500);
        }
    });

    // Requeue a single event
    app.post('/dlq/requeue/:shard/:entryId', async (c) => {
        try {
            const shard = c.req.param('shard');
            const entryId = c.req.param('entryId');

            const success = await dlq.requeueEvent(shard, entryId);

            if (success) {
                logger.info('Event requeued via admin API', { shard, entry_id: entryId });
                return c.json({ success: true, message: 'Event requeued' });
            }

            return c.json({ success: false, error: 'Event not found' }, 404);
        } catch (error) {
            logger.error('Failed to requeue event', { error: String(error) });
            return c.json({ success: false, error: 'Failed to requeue' }, 500);
        }
    });

    // Requeue all events for a shard
    app.post('/dlq/requeue/:shard', async (c) => {
        try {
            const shard = c.req.param('shard');

            const count = await dlq.requeueAll(shard);

            logger.info('All events requeued via admin API', { shard, count });
            return c.json({
                success: true,
                message: `Requeued ${count} events`,
                count,
            });
        } catch (error) {
            logger.error('Failed to requeue all events', { error: String(error) });
            return c.json({ success: false, error: 'Failed to requeue all' }, 500);
        }
    });

    // Get DLQ entry details
    app.get('/dlq/shards/:shard/entries/:entryId', async (c) => {
        try {
            const shard = c.req.param('shard');
            const entryId = c.req.param('entryId');

            const entries = await dlq.getDLQEntries(shard, 1000);
            const entry = entries.find(e => e.id === entryId);

            if (!entry) {
                return c.json({ success: false, error: 'Entry not found' }, 404);
            }

            return c.json({
                success: true,
                data: entry,
            });
        } catch (error) {
            logger.error('Failed to get DLQ entry', { error: String(error) });
            return c.json({ success: false, error: 'Failed to get entry' }, 500);
        }
    });

    return app;
}
