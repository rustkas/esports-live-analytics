/**
 * GraphQL Resolvers
 */

import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { REDIS_KEYS, createLogger } from '@esports/shared';
import { config } from './config';
import type { DbMatch, DbTeam, DbMatchMap } from './database';

const logger = createLogger('api-gateway:resolvers', config.logLevel as 'debug' | 'info');

export interface ResolverContext {
    db: Pool;
    redis: Redis;
}

export function createResolvers(ctx: ResolverContext) {
    const { db, redis } = ctx;

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

    return {
        Query: {
            async match(_: unknown, { id }: { id: string }) {
                const result = await db.query<DbMatch>(
                    `SELECT * FROM matches WHERE id = $1`,
                    [id]
                );
                return result.rows[0] ?? null;
            },

            async matches(
                _: unknown,
                { status, limit = 20, offset = 0 }: { status?: string; limit?: number; offset?: number }
            ) {
                let query = 'SELECT * FROM matches';
                const params: unknown[] = [];

                if (status) {
                    params.push(status.toLowerCase());
                    query += ` WHERE status = $1`;
                }

                query += ` ORDER BY COALESCE(started_at, scheduled_at) DESC`;

                const countResult = await db.query<{ count: string }>(
                    status
                        ? 'SELECT COUNT(*) as count FROM matches WHERE status = $1'
                        : 'SELECT COUNT(*) as count FROM matches',
                    status ? [status.toLowerCase()] : []
                );

                params.push(limit);
                query += ` LIMIT $${params.length}`;

                params.push(offset);
                query += ` OFFSET $${params.length}`;

                const result = await db.query<DbMatch>(query, params);

                const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

                return {
                    items: result.rows,
                    total,
                    hasMore: offset + result.rows.length < total,
                };
            },

            async team(_: unknown, { id }: { id: string }) {
                const result = await db.query<DbTeam>(
                    'SELECT * FROM teams WHERE id = $1',
                    [id]
                );
                return result.rows[0] ?? null;
            },

            async prediction(_: unknown, { matchId }: { matchId: string }) {
                try {
                    const result = await fetchService(
                        `${config.services.predictor}/prediction/${matchId}`
                    ) as { success: boolean; prediction?: unknown };

                    return result.success ? result.prediction : null;
                } catch {
                    return null;
                }
            },

            async predictionHistory(
                _: unknown,
                { matchId, mapId }: { matchId: string; mapId: string }
            ) {
                try {
                    const result = await fetchService(
                        `${config.services.analytics}/matches/${matchId}/maps/${mapId}/predictions`
                    ) as { success: boolean; data?: unknown };

                    return result.success ? result.data : null;
                } catch {
                    return null;
                }
            },

            async roundMetrics(
                _: unknown,
                { matchId, mapId }: { matchId: string; mapId: string }
            ) {
                try {
                    const result = await fetchService(
                        `${config.services.analytics}/matches/${matchId}/maps/${mapId}/rounds`
                    ) as { success: boolean; data?: unknown[] };

                    return result.success ? result.data : [];
                } catch {
                    return [];
                }
            },
        },

        // Field resolvers for Match
        Match: {
            tournamentName: (match: DbMatch) => match.tournament_name,
            format: (match: DbMatch) => match.format.toUpperCase(),
            status: (match: DbMatch) => match.status.toUpperCase(),
            scheduledAt: (match: DbMatch) => match.scheduled_at?.toISOString(),
            startedAt: (match: DbMatch) => match.started_at?.toISOString(),
            finishedAt: (match: DbMatch) => match.finished_at?.toISOString(),
            teamAMapsWon: (match: DbMatch) => match.team_a_maps_won,
            teamBMapsWon: (match: DbMatch) => match.team_b_maps_won,

            async teamA(match: DbMatch) {
                const result = await db.query<DbTeam>(
                    'SELECT * FROM teams WHERE id = $1',
                    [match.team_a_id]
                );
                return result.rows[0];
            },

            async teamB(match: DbMatch) {
                const result = await db.query<DbTeam>(
                    'SELECT * FROM teams WHERE id = $1',
                    [match.team_b_id]
                );
                return result.rows[0];
            },

            async winner(match: DbMatch) {
                if (!match.winner_id) return null;
                const result = await db.query<DbTeam>(
                    'SELECT * FROM teams WHERE id = $1',
                    [match.winner_id]
                );
                return result.rows[0] ?? null;
            },

            async currentMap(match: DbMatch) {
                const result = await db.query<DbMatchMap>(
                    `SELECT * FROM match_maps WHERE match_id = $1 AND status = 'live' LIMIT 1`,
                    [match.id]
                );
                return result.rows[0] ?? null;
            },

            async maps(match: DbMatch) {
                const result = await db.query<DbMatchMap>(
                    'SELECT * FROM match_maps WHERE match_id = $1 ORDER BY map_number',
                    [match.id]
                );
                return result.rows;
            },

            async prediction(match: DbMatch) {
                try {
                    const data = await redis.get(REDIS_KEYS.latestPrediction(match.id));
                    return data ? JSON.parse(data) : null;
                } catch {
                    return null;
                }
            },
        },

        // Field resolvers for Team
        Team: {
            shortName: (team: DbTeam) => team.short_name,
            logoUrl: (team: DbTeam) => team.logo_url,
        },

        // Field resolvers for MatchMap
        MatchMap: {
            mapName: (map: DbMatchMap) => map.map_name,
            mapNumber: (map: DbMatchMap) => map.map_number,
            status: (map: DbMatchMap) => map.status.toUpperCase(),
            teamAScore: (map: DbMatchMap) => map.team_a_score,
            teamBScore: (map: DbMatchMap) => map.team_b_score,
            currentRound: (map: DbMatchMap) => map.current_round,

            async winner(map: DbMatchMap) {
                if (!map.winner_id) return null;
                const result = await db.query<DbTeam>(
                    'SELECT * FROM teams WHERE id = $1',
                    [map.winner_id]
                );
                return result.rows[0] ?? null;
            },
        },

        // Field resolvers for Prediction
        Prediction: {
            matchId: (p: Record<string, unknown>) => p.match_id,
            mapId: (p: Record<string, unknown>) => p.map_id,
            roundNo: (p: Record<string, unknown>) => p.round_no,
            teamAWinProbability: (p: Record<string, unknown>) => p.p_team_a_win,
            teamBWinProbability: (p: Record<string, unknown>) => p.p_team_b_win,
            modelVersion: (p: Record<string, unknown>) => p.model_version,
            calculatedAt: (p: Record<string, unknown>) => p.ts_calc,
            stateVersion: (p: Record<string, unknown>) => p.state_version,
        },

        // Field resolvers for PredictionHistory
        PredictionHistory: {
            matchId: (h: Record<string, unknown>) => h.match_id,
            mapId: (h: Record<string, unknown>) => h.map_id,
            teamAId: (h: Record<string, unknown>) => h.team_a_id,
            teamBId: (h: Record<string, unknown>) => h.team_b_id,
        },

        // Field resolvers for PredictionPoint
        PredictionPoint: {
            tsCalc: (p: Record<string, unknown>) => p.ts_calc,
            roundNo: (p: Record<string, unknown>) => p.round_no,
            pTeamAWin: (p: Record<string, unknown>) => p.p_team_a_win,
            pTeamBWin: (p: Record<string, unknown>) => p.p_team_b_win,
            confidence: (p: Record<string, unknown>) => p.confidence,
            triggerEventType: (p: Record<string, unknown>) => p.trigger_event_type,
            stateVersion: (p: Record<string, unknown>) => p.state_version,
        },

        // Field resolvers for RoundMetrics
        RoundMetrics: {
            roundNo: (m: Record<string, unknown>) => m.round_no,
            teamAKills: (m: Record<string, unknown>) => m.team_a_kills,
            teamBKills: (m: Record<string, unknown>) => m.team_b_kills,
            teamAHeadshots: (m: Record<string, unknown>) => m.team_a_headshots,
            teamBHeadshots: (m: Record<string, unknown>) => m.team_b_headshots,
            clutchIndex: (m: Record<string, unknown>) => m.clutch_index,
            roundWinner: (m: Record<string, unknown>) => m.round_winner,
        },

        // Subscriptions - using Redis pub/sub
        Subscription: {
            predictionUpdated: {
                async *subscribe(_: unknown, { matchId }: { matchId: string }) {
                    const subscriber = redis.duplicate();
                    await subscriber.subscribe(REDIS_KEYS.predictionUpdates(matchId));

                    let lastVersion = 0;

                    try {
                        while (true) {
                            const message = await new Promise<string | null>((resolve) => {
                                subscriber.once('message', (_, msg) => resolve(msg));
                                // Timeout after 30 seconds to check if still needed
                                setTimeout(() => resolve(null), 30000);
                            });

                            if (message) {
                                const data = JSON.parse(message);
                                const currentVersion = data.data?.state_version || 0;

                                // Only emit if version is newer (monotonicity check)
                                if (currentVersion > lastVersion) {
                                    lastVersion = currentVersion;

                                    yield {
                                        predictionUpdated: {
                                            matchId: data.match_id,
                                            mapId: data.data?.map_id,
                                            roundNo: data.data?.round_no,
                                            teamAWinProbability: data.data?.p_team_a_win,
                                            teamBWinProbability: data.data?.p_team_b_win,
                                            confidence: data.data?.confidence,
                                            triggerEventType: data.data?.trigger_event_type,
                                            timestamp: data.timestamp,
                                            stateVersion: currentVersion,
                                        },
                                    };
                                }
                            }
                        }
                    } finally {
                        await subscriber.unsubscribe();
                        await subscriber.quit();
                    }
                },
            },

            scoreUpdated: {
                async *subscribe(_: unknown, { matchId }: { matchId: string }) {
                    const subscriber = redis.duplicate();
                    await subscriber.subscribe(REDIS_KEYS.matchUpdates(matchId));

                    try {
                        while (true) {
                            const message = await new Promise<string | null>((resolve) => {
                                subscriber.once('message', (_, msg) => resolve(msg));
                                setTimeout(() => resolve(null), 30000);
                            });

                            if (message) {
                                const data = JSON.parse(message);
                                if (data.type === 'state' && data.data) {
                                    yield {
                                        scoreUpdated: {
                                            matchId: data.match_id,
                                            mapId: data.data.map_id,
                                            teamAScore: data.data.team_a_score,
                                            teamBScore: data.data.team_b_score,
                                            currentRound: data.data.current_round,
                                            timestamp: data.timestamp,
                                        },
                                    };
                                }
                            }
                        }
                    } finally {
                        await subscriber.unsubscribe();
                        await subscriber.quit();
                    }
                },
            },

            matchEvents: {
                async *subscribe(_: unknown, { matchId }: { matchId: string }) {
                    const subscriber = redis.duplicate();
                    await subscriber.subscribe(REDIS_KEYS.matchUpdates(matchId));

                    try {
                        while (true) {
                            const message = await new Promise<string | null>((resolve) => {
                                subscriber.once('message', (_, msg) => resolve(msg));
                                setTimeout(() => resolve(null), 30000);
                            });

                            if (message) {
                                const data = JSON.parse(message);
                                yield {
                                    matchEvents: {
                                        type: data.type,
                                        matchId: data.match_id,
                                        timestamp: data.timestamp,
                                        data: JSON.stringify(data.data),
                                    },
                                };
                            }
                        }
                    } finally {
                        await subscriber.unsubscribe();
                        await subscriber.quit();
                    }
                },
            },
        },
    };
}
