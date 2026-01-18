/**
 * ClickHouse Query Service
 * Executes optimized queries for analytics
 */

import { createClient, type ClickHouseClient } from '@clickhouse/client';
import type { RoundMetrics, PredictionHistory, MatchMetrics } from '@esports/shared';
import { createLogger } from '@esports/shared';
import { config } from './config';

const logger = createLogger('analytics:queries', config.logLevel as 'debug' | 'info');

export interface QueryService {
    getRoundMetrics(matchId: string, mapId: string): Promise<RoundMetrics[]>;
    getMatchMetrics(matchId: string): Promise<MatchMetrics | null>;
    getPredictionHistory(matchId: string, mapId: string): Promise<PredictionHistory>;
    getEventCounts(matchId: string): Promise<Record<string, number>>;
    close(): Promise<void>;
}

export function createQueryService(): QueryService {
    const client = createClient({
        host: config.clickhouse.url,
        database: config.clickhouse.database,
        request_timeout: 5000,
    });

    return {
        async getRoundMetrics(matchId: string, mapId: string): Promise<RoundMetrics[]> {
            const startTime = performance.now();

            const result = await client.query({
                query: `
          SELECT 
            match_id,
            map_id,
            round_no,
            team_a_kills,
            team_b_kills,
            team_a_headshots,
            team_b_headshots,
            team_a_econ,
            team_b_econ,
            momentum,
            clutch_index,
            economy_pressure,
            first_blood_team,
            round_winner
          FROM cs2_round_metrics FINAL
          WHERE match_id = {matchId:UUID} AND map_id = {mapId:UUID}
          ORDER BY round_no ASC
        `,
                query_params: { matchId, mapId },
                format: 'JSONEachRow',
            });

            const rows = await result.json<RoundMetrics[]>();

            logger.debug('Round metrics query', {
                match_id: matchId,
                count: rows.length,
                latency_ms: (performance.now() - startTime).toFixed(2),
            });

            return rows;
        },

        async getMatchMetrics(matchId: string): Promise<MatchMetrics | null> {
            const startTime = performance.now();

            const result = await client.query({
                query: `
          SELECT 
            match_id,
            map_id,
            team_a_rounds,
            team_b_rounds,
            team_a_total_kills,
            team_b_total_kills,
            team_a_hs_percentage,
            team_b_hs_percentage,
            current_momentum,
            avg_round_duration_sec,
            status
          FROM cs2_match_metrics FINAL
          WHERE match_id = {matchId:UUID}
          LIMIT 1
        `,
                query_params: { matchId },
                format: 'JSONEachRow',
            });

            const rows = await result.json<MatchMetrics[]>();

            logger.debug('Match metrics query', {
                match_id: matchId,
                found: rows.length > 0,
                latency_ms: (performance.now() - startTime).toFixed(2),
            });

            return rows[0] ?? null;
        },

        async getPredictionHistory(matchId: string, mapId: string): Promise<PredictionHistory> {
            const startTime = performance.now();

            const result = await client.query({
                query: `
          SELECT 
            ts_calc,
            round_no,
            p_team_a_win,
            p_team_b_win,
            confidence,
            trigger_event_type
          FROM cs2_predictions
          WHERE match_id = {matchId:UUID} AND map_id = {mapId:UUID}
          ORDER BY ts_calc ASC
        `,
                query_params: { matchId, mapId },
                format: 'JSONEachRow',
            });

            interface PredictionRow {
                ts_calc: string;
                round_no: number;
                p_team_a_win: number;
                p_team_b_win: number;
                confidence: number;
                trigger_event_type?: string;
            }

            const rows = await result.json<PredictionRow[]>();

            logger.debug('Prediction history query', {
                match_id: matchId,
                count: rows.length,
                latency_ms: (performance.now() - startTime).toFixed(2),
            });

            // Get team IDs from first prediction
            const teamsResult = await client.query({
                query: `
          SELECT team_a_id, team_b_id
          FROM cs2_predictions
          WHERE match_id = {matchId:UUID} AND map_id = {mapId:UUID}
          LIMIT 1
        `,
                query_params: { matchId, mapId },
                format: 'JSONEachRow',
            });

            const teams = await teamsResult.json<{ team_a_id: string; team_b_id: string }[]>();

            return {
                match_id: matchId,
                map_id: mapId,
                team_a_id: teams[0]?.team_a_id ?? '',
                team_b_id: teams[0]?.team_b_id ?? '',
                points: rows.map(row => ({
                    ts_calc: row.ts_calc,
                    round_no: row.round_no,
                    p_team_a_win: row.p_team_a_win,
                    p_team_b_win: row.p_team_b_win,
                    confidence: row.confidence,
                    trigger_event_type: row.trigger_event_type,
                })),
            };
        },

        async getEventCounts(matchId: string): Promise<Record<string, number>> {
            const result = await client.query({
                query: `
          SELECT type, count() as cnt
          FROM cs2_events_raw
          WHERE match_id = {matchId:UUID}
          GROUP BY type
          ORDER BY cnt DESC
        `,
                query_params: { matchId },
                format: 'JSONEachRow',
            });

            const rows = await result.json<{ type: string; cnt: number }[]>();

            const counts: Record<string, number> = {};
            for (const row of rows) {
                counts[row.type] = row.cnt;
            }

            return counts;
        },

        async close(): Promise<void> {
            await client.close();
        },
    };
}
