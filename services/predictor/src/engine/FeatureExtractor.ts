import type { MatchState } from '@esports/shared';
import type { FeatureVector } from './types';

export class FeatureExtractor {
    static extract(state: MatchState): FeatureVector {
        const a = state.team_a;
        const b = state.team_b;

        // Normalize economy (cap at 30k diff)
        const econ_diff = Math.max(-1, Math.min(1, (a.money - b.money) / 10000));
        const equip_diff = Math.max(-1, Math.min(1, (a.equipment_value - b.equipment_value) / 10000));

        return {
            econ_diff,
            equip_diff,

            round_no: state.round_no,
            team_a_score: a.score,
            team_b_score: b.score,

            alive_diff: a.alive_count - b.alive_count,
            bomb_planted: state.bomb_planted,

            win_streak_a: a.consecutive_round_losses === 0 ? 1 : 0, // Simplified: if no losses, maybe on streak? 
            // Better: state.consecutive_round_losses tracks LOSSES. 
            // If A has 0 losses, A might be winning, but we don't know streak length without history.
            // For now, use inverted losses as weak signal or specific logic.
            // If B has 5 losses, A has 5 win streak.
            win_streak_a: b.consecutive_round_losses,
            win_streak_b: a.consecutive_round_losses,

            strength_diff: (a.strength_rating - b.strength_rating) / 500, // Normalize Elo diff
        };
    }
}
