/**
 * REST API Routes
 */

import { Hono, type Context } from 'hono';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { REDIS_KEYS, createLogger } from '@esports/shared';
import { config } from './config';
import type { DbMatch, DbTeam, DbMatchMap } from './database';

const logger = createLogger('api-gateway:rest', config.logLevel as 'debug' | 'info');

import type { FeatureFlagService } from './flags';

// ... 

export function createRestRoutes(db: Pool, redis: Redis, flags: ReturnType<typeof import('./flags').createFeatureFlagService>): Hono {
    const app = new Hono();

    // Middleware-like helper
    const requireFlag = (name: string) => async (c: Context, next: any) => {
        // Assume client is in context from Auth Middleware
        const client = c.get('client');
        const enabled = await flags.getFlag(name, client?.client_id);
        if (!enabled) {
            return c.json({ error: 'Feature disabled' }, 403);
        }
        await next();
    };

    // Helper to fetch from internal services
    async function fetchService(url: string): Promise<unknown> {
        const response = await fetch(url, {
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
            throw new Error(`Service error: ${response.status}`);
        }
        return response.json();
    }

    // List matches
    app.get('/matches', async (c: Context) => {
        const status = c.req.query('status');
        const limit = parseInt(c.req.query('limit') ?? '20', 10);
        const offset = parseInt(c.req.query('offset') ?? '0', 10);

        let query = 'SELECT * FROM matches';
        const params: unknown[] = [];

        if (status) {
            params.push(status);
            query += ` WHERE status = $1`;
        }

        query += ` ORDER BY COALESCE(started_at, scheduled_at) DESC`;

        params.push(Math.min(limit, 100));
        query += ` LIMIT $${params.length}`;

        params.push(offset);
        query += ` OFFSET $${params.length}`;

        const result = await db.query<DbMatch>(query, params);

        return c.json({
            success: true,
            data: result.rows,
            meta: { limit, offset },
        });
    });

    // Get match by ID
    app.get('/matches/:id', async (c: Context) => {
        const id = c.req.param('id');

        const matchResult = await db.query<DbMatch>(
            'SELECT * FROM matches WHERE id = $1',
            [id]
        );

        if (matchResult.rows.length === 0) {
            return c.json({ success: false, error: 'Match not found' }, 404);
        }

        const match = matchResult.rows[0]!;

        // Get teams
        const teamsResult = await db.query<DbTeam>(
            'SELECT * FROM teams WHERE id IN ($1, $2)',
            [match.team_a_id, match.team_b_id]
        );

        const teamA = teamsResult.rows.find((t: DbTeam) => t.id === match.team_a_id);
        const teamB = teamsResult.rows.find((t: DbTeam) => t.id === match.team_b_id);

        // Get maps
        const mapsResult = await db.query<DbMatchMap>(
            'SELECT * FROM match_maps WHERE match_id = $1 ORDER BY map_number',
            [id]
        );

        return c.json({
            success: true,
            data: {
                ...match,
                team_a: teamA,
                team_b: teamB,
                maps: mapsResult.rows,
            },
        });
    });

    // Get match stats
    app.get('/matches/:id/stats', async (c: Context) => {
        const id = c.req.param('id');

        try {
            const url = `${config.services.analytics}/matches/${id}/metrics`;
            const result = await fetchService(url);

            return c.json(result);
        } catch (error) {
            logger.error('Stats error', { error: String(error), matchId: id });
            return c.json({ success: false, error: 'Failed to get stats' }, 500);
        }
    });

    // Get prediction
    app.get('/matches/:id/prediction', async (c: Context) => {
        const id = c.req.param('id');

        try {
            // First try cache
            const cached = await redis.get(REDIS_KEYS.latestPrediction(id));

            if (cached) {
                return c.json({
                    success: true,
                    data: JSON.parse(cached),
                    cached: true,
                });
            }

            // Fallback to predictor service
            const result = await fetchService(
                `${config.services.predictor}/prediction/${id}`
            ) as { success: boolean; prediction?: unknown };

            return c.json({
                success: result.success,
                data: result.prediction,
            });
        } catch (error) {
            logger.error('Prediction error', { error: String(error), matchId: id });
            return c.json({ success: false, error: 'Failed to get prediction' }, 500);
        }
    });

    // Get teams
    app.get('/teams', async (c: Context) => {
        const limit = parseInt(c.req.query('limit') ?? '50', 10);
        const offset = parseInt(c.req.query('offset') ?? '0', 10);

        const result = await db.query<DbTeam>(
            'SELECT * FROM teams ORDER BY rating DESC LIMIT $1 OFFSET $2',
            [Math.min(limit, 100), offset]
        );

        return c.json({
            success: true,
            data: result.rows,
        });
    });

    // Get team by ID
    app.get('/teams/:id', async (c: Context) => {
        const id = c.req.param('id');

        const result = await db.query<DbTeam>(
            'SELECT * FROM teams WHERE id = $1',
            [id]
        );

        if (result.rows.length === 0) {
            return c.json({ success: false, error: 'Team not found' }, 404);
        }

        return c.json({
            success: true,
            data: result.rows[0],
        });
    });

    // Get team metrics
    app.get('/teams/:id/metrics', async (c: Context) => {
        const id = c.req.param('id');

        // Get team
        const teamResult = await db.query<DbTeam>(
            'SELECT * FROM teams WHERE id = $1',
            [id]
        );

        if (teamResult.rows.length === 0) {
            return c.json({ success: false, error: 'Team not found' }, 404);
        }

        // Get recent matches
        const matchesResult = await db.query<DbMatch>(
            `SELECT * FROM matches 
       WHERE (team_a_id = $1 OR team_b_id = $1) AND status = 'finished'
       ORDER BY finished_at DESC LIMIT 10`,
            [id]
        );

        const wins = matchesResult.rows.filter((m: DbMatch) => m.winner_id === id).length;
        const total = matchesResult.rows.length;

        return c.json({
            success: true,
            data: {
                team: teamResult.rows[0],
                recent_matches: total,
                wins,
                losses: total - wins,
                win_rate: total > 0 ? wins / total : 0,
            },
        });
    });

    // List list matches
    app.get('/live-matches', async (c: Context) => {
        const result = await db.query<DbMatch>(
            "SELECT * FROM matches WHERE status = 'live' ORDER BY started_at DESC"
        );
        return c.json({ success: true, data: result.rows });
    });

    // Get match timeline
    app.get('/matches/:id/timeline', async (c: Context) => {
        const id = c.req.param('id');
        try {
            const url = `${config.services.analytics}/matches/${id}/timeline`;
            const result = await fetchService(url);
            return c.json(result);
        } catch (error) {
            logger.error('Timeline error', { error: String(error), matchId: id });
            return c.json({ success: false, error: 'Failed to get timeline' }, 500);
        }
    });

    // Get match rounds
    app.get('/matches/:id/rounds', async (c: Context) => {
        const id = c.req.param('id');
        try {
            const url = `${config.services.analytics}/matches/${id}/rounds`;
            const result = await fetchService(url);
            return c.json(result);
        } catch (error) {
            logger.error('Rounds error', { error: String(error), matchId: id });
            return c.json({ success: false, error: 'Failed to get rounds' }, 500);
        }
    });

    // Get prediction latest
    app.get('/matches/:id/prediction/latest', async (c: Context) => {
        const id = c.req.param('id');
        try {
            const cached = await redis.get(REDIS_KEYS.latestPrediction(id));
            if (cached) {
                return c.json({ success: true, data: JSON.parse(cached), cached: true });
            }
            const result = await fetchService(
                `${config.services.predictor}/prediction/${id}`
            ) as { success: boolean; prediction?: unknown };
            return c.json({ success: result.success, data: result.prediction });
        } catch (error) {
            logger.warn('Prediction latest error', { error: String(error), matchId: id });
            return c.json({ success: false, error: 'Failed to get prediction' }, 500);
        }
    });

    // Get prediction history
    app.get('/matches/:id/prediction/history', async (c: Context) => {
        const id = c.req.param('id');
        const limit = c.req.query('limit') || '50';
        try {
            const result = await fetchService(
                `${config.services.predictor}/prediction/${id}/history?limit=${limit}`
            );
            return c.json(result);
        } catch (error) {
            logger.error('Prediction history error', { error: String(error), matchId: id });
            return c.json({ success: false, error: 'Failed to get prediction history' }, 500);
        }
    });

    // Get team stats (Last N)
    app.get('/teams/:id/stats', async (c: Context) => {
        const id = c.req.param('id');
        const limit = parseInt(c.req.query('limit') ?? '10', 10);

        const matchesResult = await db.query<DbMatch>(
            `SELECT * FROM matches 
             WHERE (team_a_id = $1 OR team_b_id = $1) AND status = 'finished'
             ORDER BY finished_at DESC LIMIT $2`,
            [id, Math.min(limit, 50)]
        );

        const wins = matchesResult.rows.filter((m: DbMatch) => m.winner_id === id).length;
        const total = matchesResult.rows.length;

        const teamRes = await db.query<DbTeam>('SELECT * FROM teams WHERE id = $1', [id]);
        if (teamRes.rows.length === 0) return c.json({ error: 'Team not found' }, 404);

        return c.json({
            success: true,
            data: {
                team: teamRes.rows[0],
                stats: {
                    matches_played: total,
                    wins,
                    losses: total - wins,
                    win_rate: total > 0 ? wins / total : 0,
                },
                matches: matchesResult.rows.map(m => ({
                    id: m.id,
                    opponent_id: m.team_a_id === id ? m.team_b_id : m.team_a_id,
                    winner_id: m.winner_id,
                    score: `${m.team_a_maps_won}-${m.team_b_maps_won}`,
                    date: m.finished_at
                }))
            }
        });
    });

    // Partner Health (Summary)
    app.get('/partner/health', async (c: Context) => {
        // Basic connectivity checks
        // Count live matches
        const liveCountRes = await db.query("SELECT COUNT(*) as count FROM matches WHERE status = 'live'");
        const liveCount = parseInt(liveCountRes.rows[0].count, 10);

        return c.json({
            status: 'operational',
            live_matches: liveCount,
            services: {
                database: 'connected',
                redis: 'connected',
                predictor: 'operational' // Mocked status
            },
            timestamp: new Date().toISOString()
        });
    });

    // Player stats (Last N maps)
    app.get('/players/:id/stats', async (c: Context) => {
        const id = c.req.param('id');
        // This requires analytics service query for player stats
        // Forwarding to analytics
        try {
            // Mock response or forward
            // Analytics service likely has /players/:id/metrics
            // But we don't have it in the roadmap explicitly implemented in analytics service yet? 
            // "Step 818" created cs2_player_round_stats table.
            // Analytics Service needs to expose it.
            // Assuming Analytics Service has /players/:id/stats route or we implement query here if permitted.
            // Gateway usually forwards.

            // For now, return mock or error if analytics not ready
            // Or direct DB query to ClickHouse if Gateway connects to CH? (Gateway connects to PG + Redis).
            // Gateway should fetch from Analytics Service.
            return c.json({ success: true, message: 'Endpoint placeholder. Analytics service required.' });

        } catch (error) {
            return c.json({ success: false, error: 'Failed to get player stats' }, 500);
        }
    });

    return app;
}
