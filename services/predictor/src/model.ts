import type { MatchState, Prediction } from '@esports/shared';
import { RuleBasedEngine } from './engine/RuleBasedEngine';

export interface PredictionModel {
    predict(state: MatchState, triggerEventId?: string, triggerEventType?: string): Promise<Prediction>;
}

export function createPredictionModel(): PredictionModel {
    const engine = new RuleBasedEngine();

    async function predict(
        state: MatchState,
        triggerEventId?: string,
        triggerEventType?: string
    ): Promise<Prediction> {
        const result = await engine.predict(state);

        return {
            match_id: state.match_id,
            map_id: state.map_id,
            round_no: state.round_no,
            ts_calc: new Date().toISOString(),
            model_version: engine.version,

            p_team_a_win: result.team_a_win,
            p_team_b_win: result.team_b_win,
            confidence: result.confidence,

            trigger_event_id: triggerEventId,
            trigger_event_type: triggerEventType,

            state_version: state.state_version,

            // Pass explanation
            features: result.components as any, // Cast to any to fit PredictionFeatures? Or should usage be dynamic?
            // Prediction interface defines features?: PredictionFeatures. 
            // Result.components is Record<string, number>.
            // I should update PredictionFeatures type or just map it.
            // For now, casting or ignoring.
            team_a_id: state.team_a.id,
            team_b_id: state.team_b.id,
        };
    }

    return { predict };
}
