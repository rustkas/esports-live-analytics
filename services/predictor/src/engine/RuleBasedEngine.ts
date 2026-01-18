import type { MatchState } from '@esports/shared';
import type { PredictorEngine, PredictionResult } from './types';
import { FeatureExtractor } from './FeatureExtractor';

export class RuleBasedEngine implements PredictorEngine {
    version = 'v0.1.0-baseline';

    async predict(state: MatchState): Promise<PredictionResult> {
        const f = FeatureExtractor.extract(state);
        let p = 0.5;

        // 1. Prior Strength (Baseline)
        p += f.strength_diff * 0.1;

        // 2. Live Manpower (Strongest signal)
        // +1 man advantage ~= +15% win prob
        p += f.alive_diff * 0.15;

        // 3. Equipment Advantage
        p += f.equip_diff * 0.05;

        // 4. Bomb Logic
        if (f.bomb_planted) {
            // Terrorists gain massive advantage when bomb is down
            // But CTs gain advantage if they have time/kits (not modeled yet)
            // Assuming A is T for simplicity or strictly checking side
            if (state.team_a.side === 'T') {
                p += 0.25;
            } else {
                p -= 0.25;
            }
        }

        // 5. Momentum
        const streak_factor = (f.win_streak_a - f.win_streak_b) * 0.02;
        p += streak_factor;

        // Clamp
        p = Math.max(0.05, Math.min(0.95, p));

        // Confidence Calculation
        // Early round (5v5) -> Low confidence
        // Late round (1v1 or bomb) -> High confidence
        const totalAlive = state.team_a.alive_count + state.team_b.alive_count;
        let confidence = 1.0 - (totalAlive / 10); // 0.0 to 1.0

        // Boost confidence if bomb planted
        if (f.bomb_planted) confidence += 0.2;

        confidence = Math.max(0.1, Math.min(0.95, confidence));

        return {
            team_a_win: p,
            team_b_win: 1 - p,
            confidence,
            components: {
                alive_diff: f.alive_diff,
                equip_diff: f.equip_diff,
                bomb: f.bomb_planted ? 1 : 0
            }
        };
    }
}
