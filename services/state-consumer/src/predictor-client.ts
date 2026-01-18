/**
 * Prediction Trigger
 * Calls predictor service when significant events occur
 */

import type { MatchState, BaseEvent } from '@esports/shared';
import { isPredictionTrigger, createLogger } from '@esports/shared';
import { config } from './config';

const logger = createLogger('state-consumer:predictor', config.logLevel as 'debug' | 'info');

// ... types
export interface PredictionResult {
    match_id: string;
    map_id: string;
    round_no: number;
    team_a_win: number;
    team_b_win: number;
    model_version: string;
    features?: Record<string, any>;
    confidence?: number;
    ts_calc?: string;
}

export interface PredictorClient {
    triggerPrediction(event: BaseEvent, state: MatchState): Promise<PredictionResult | null>;
}

export function createPredictorClient(): PredictorClient {
    return {
        async triggerPrediction(event: BaseEvent, state: MatchState): Promise<PredictionResult | null> {
            if (!config.predictor.enabled) {
                return null;
            }

            // Only trigger on significant events
            if (!isPredictionTrigger(event.type)) {
                return null;
            }

            try {
                const response = await fetch(`${config.predictor.url}/predict`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        match_id: event.match_id,
                        map_id: event.map_id,
                        round_no: event.round_no,
                        state,
                        trigger_event_id: event.event_id,
                        trigger_event_type: event.type,
                    }),
                    signal: AbortSignal.timeout(5000),
                });

                if (!response.ok) {
                    logger.warn('Predictor returned error', {
                        status: response.status,
                        match_id: event.match_id,
                    });
                    return null;
                }

                const result = await response.json() as PredictionResult;

                logger.debug('Prediction triggered', {
                    match_id: event.match_id,
                    event_type: event.type,
                    prob_a: result.team_a_win
                });

                return result;
            } catch (error) {
                logger.error('Failed to trigger prediction', {
                    error: String(error),
                    match_id: event.match_id,
                });
                return null;
            }
        },
    };
}
