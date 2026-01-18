/**
 * Prediction Trigger
 * Calls predictor service when significant events occur
 */

import type { MatchState, BaseEvent } from '@esports/shared';
import { isPredictionTrigger, createLogger } from '@esports/shared';
import { config } from './config';

const logger = createLogger('state-consumer:predictor', config.logLevel as 'debug' | 'info');

export interface PredictorClient {
    triggerPrediction(event: BaseEvent, state: MatchState): Promise<void>;
}

export function createPredictorClient(): PredictorClient {
    return {
        async triggerPrediction(event: BaseEvent, state: MatchState): Promise<void> {
            if (!config.predictor.enabled) {
                return;
            }

            // Only trigger on significant events
            if (!isPredictionTrigger(event.type)) {
                return;
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
                    return;
                }

                logger.debug('Prediction triggered', {
                    match_id: event.match_id,
                    event_type: event.type,
                });
            } catch (error) {
                logger.error('Failed to trigger prediction', {
                    error: String(error),
                    match_id: event.match_id,
                });
            }
        },
    };
}
