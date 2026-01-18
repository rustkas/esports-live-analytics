/**
 * Prediction Storage
 * Caches predictions in Redis and writes to ClickHouse
 */

import type { Redis } from 'ioredis';
import { createClient } from '@clickhouse/client';
import type { Prediction } from '@esports/shared';
import { REDIS_KEYS, createLogger } from '@esports/shared';
import { config } from './config';

const logger = createLogger('predictor:storage', config.logLevel as 'debug' | 'info');

export interface PredictionStorage {
    save(prediction: Prediction): Promise<void>;
    getLatest(matchId: string): Promise<Prediction | null>;
    getHistory(matchId: string, limit: number): Promise<Prediction[]>;
    publish(prediction: Prediction): Promise<void>;
    close(): Promise<void>;
}

export function createPredictionStorage(redis: Redis): PredictionStorage {
    const clickhouse = createClient({
        host: config.clickhouse.url,
        database: config.clickhouse.database,
    });

    return {
        async getHistory(matchId: string, limit: number): Promise<Prediction[]> {
            try {
                const result = await clickhouse.query({
                    query: `
                        SELECT *
                        FROM cs2_predictions
                        WHERE match_id = {matchId: UUID}
                        ORDER BY ts_calc DESC
                        LIMIT {limit: UInt32}
                    `,
                    query_params: {
                        matchId: matchId,
                        limit: limit
                    },
                    format: 'JSONEachRow'
                });

                const rows = await result.json<Array<Record<string, any>>>();
                return rows.map((row) => ({
                    ...row,
                    features: row.features && typeof row.features === 'string'
                        ? JSON.parse(row.features)
                        : undefined
                })) as unknown as Prediction[];
            } catch (err) {
                logger.error('Failed to get history', { error: String(err), matchId });
                return [];
            }
        },

        async save(prediction: Prediction): Promise<void> {
            // Save to Redis (latest)
            const key = REDIS_KEYS.latestPrediction(prediction.match_id);
            await redis.set(key, JSON.stringify(prediction), 'EX', config.cache.ttlSeconds);

            // Write to ClickHouse (history)
            try {
                await clickhouse.insert({
                    table: 'cs2_predictions',
                    values: [{
                        date: prediction.ts_calc.split('T')[0],
                        ts_calc: prediction.ts_calc,
                        match_id: prediction.match_id,
                        map_id: prediction.map_id,
                        round_no: prediction.round_no,
                        model_version: prediction.model_version,
                        team_a_id: prediction.team_a_id,
                        team_b_id: prediction.team_b_id,
                        p_team_a_win: prediction.p_team_a_win,
                        p_team_b_win: prediction.p_team_b_win,
                        confidence: prediction.confidence,
                        features: prediction.features ? JSON.stringify(prediction.features) : '{}',
                        trigger_event_id: prediction.trigger_event_id ?? '',
                        trigger_event_type: prediction.trigger_event_type ?? '',
                    }],
                    format: 'JSONEachRow',
                });

                logger.debug('Prediction saved to ClickHouse', {
                    match_id: prediction.match_id,
                });
            } catch (error) {
                logger.error('Failed to save prediction to ClickHouse', {
                    error: String(error),
                    match_id: prediction.match_id,
                });
                // Don't throw - Redis save is the critical path
            }
        },

        async getLatest(matchId: string): Promise<Prediction | null> {
            const key = REDIS_KEYS.latestPrediction(matchId);
            const data = await redis.get(key);

            if (!data) {
                return null;
            }

            return JSON.parse(data) as Prediction;
        },

        async publish(prediction: Prediction): Promise<void> {
            const channel = REDIS_KEYS.predictionUpdates(prediction.match_id);
            await redis.publish(channel, JSON.stringify({
                type: 'prediction',
                match_id: prediction.match_id,
                timestamp: prediction.ts_calc,
                data: {
                    round_no: prediction.round_no,
                    p_team_a_win: prediction.p_team_a_win,
                    p_team_b_win: prediction.p_team_b_win,
                    confidence: prediction.confidence,
                    trigger_event_type: prediction.trigger_event_type,
                },
            }));

            logger.debug('Prediction published', {
                match_id: prediction.match_id,
                channel,
            });
        },

        async close(): Promise<void> {
            await clickhouse.close();
        },
    };
}
