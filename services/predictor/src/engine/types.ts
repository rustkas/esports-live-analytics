import type { MatchState } from '@esports/shared';

export interface FeatureVector {
    // Econ
    econ_diff: number; // A - B relative to max
    equip_diff: number;

    // Board
    round_no: number;
    team_a_score: number;
    team_b_score: number;

    // Live
    alive_diff: number; // A - B
    bomb_planted: boolean;

    // Momentum
    win_streak_a: number;
    win_streak_b: number;

    // Priors
    strength_diff: number;
}

export interface PredictionResult {
    team_a_win: number;
    team_b_win: number;
    confidence: number;
    components: Record<string, number>;
}

export interface PredictorEngine {
    version: string;
    predict(state: MatchState): Promise<PredictionResult>;
}
