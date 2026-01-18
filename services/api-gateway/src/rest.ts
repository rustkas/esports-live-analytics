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

export function createRestRoutes(db: Pool, redis: Redis): Hono {
    const app = new Hono();

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

    return app;
}
