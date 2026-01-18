import type { MatchState, Prediction } from '@esports/shared';
import {
    clampProbability,
    validateProbability,
    isAnomalousJump,
    formatOdds
} from '@esports/shared';
import { RuleBasedEngine } from './engine/RuleBasedEngine';

export interface PredictionModel {
    predict(
        state: MatchState,
        triggerEventId?: string,
        triggerEventType?: string,
        lastPrediction?: Prediction | null
    ): Promise<Prediction>;
}

export function createPredictionModel(): PredictionModel {
    const engine = new RuleBasedEngine();

    async function predict(
        state: MatchState,
        triggerEventId?: string,
        triggerEventType?: string,
        lastPrediction?: Prediction | null
    ): Promise<Prediction> {
        // 1. Calculate Raw Prediction (with Circuit Breaker)
        let result: any;
        try {
            result = await engine.predict(state);
        } catch (err) {
            // Circuit Breaker: Fallback to last known good state
            if (lastPrediction) {
                return {
                    ...lastPrediction,
                    ts_calc: new Date().toISOString(),
                    trigger_event_id: triggerEventId,
                    trigger_event_type: triggerEventType,
                    confidence: 0.1, // Signal degradation
                };
            }
            throw err; // No fallback
        }

        // 2. Validate & Clamp
        let pA = validateProbability(result.team_a_win);

        // 3. Anomaly Detection (Swing Check)
        if (lastPrediction) {
            const lastPA = lastPrediction.p_team_a_win;
            const timeDiff = (Date.now() - new Date(lastPrediction.ts_calc).getTime()) / 1000;

            if (isAnomalousJump(lastPA, pA, timeDiff)) {
                // Determine allowed range
                const dir = pA > lastPA ? 1 : -1;
                const maxChange = 0.20 + (Math.max(0, timeDiff) * 0.05);
                const allowedDiff = Math.min(Math.abs(pA - lastPA), maxChange);
                pA = validateProbability(lastPA + (dir * allowedDiff));
            }
        }

        let pB = 1 - pA;

        // 4. Odds Generation
        const oddsA = formatOdds(pA);
        const oddsB = formatOdds(pB);

        // 5. Build Result
        return {
            match_id: state.match_id,
            map_id: state.map_id,
            round_no: state.round_no,
            ts_calc: new Date().toISOString(),
            model_version: engine.version,

            p_team_a_win: pA,
            p_team_b_win: pB,
            confidence: result.confidence,

            trigger_event_id: triggerEventId,
            trigger_event_type: triggerEventType,

            state_version: state.state_version,

            features: {
                ...result.components,
                odds_a: oddsA.decimal,
                odds_b: oddsB.decimal
            } as any,

            team_a_id: state.team_a.id,
            team_b_id: state.team_b.id,
        };
    }

    return { predict };
}
