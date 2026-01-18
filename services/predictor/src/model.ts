/**
 * Rule-Based Prediction Model
 * 
 * This is a simplified model for demonstration purposes.
 * In production, this would be replaced with ML models.
 * 
 * The model considers:
 * - Current score advantage
 * - Momentum (recent round wins)
 * - Economy difference
 * - Current round alive players
 */

import type { MatchState, Prediction, PredictionFeatures } from '@esports/shared';
import { CS2, createLogger } from '@esports/shared';
import { config } from './config';

const logger = createLogger('predictor:model', config.logLevel as 'debug' | 'info');

export interface PredictionModel {
    predict(state: MatchState, triggerEventId?: string, triggerEventType?: string): Prediction;
}

export function createPredictionModel(): PredictionModel {
    const weights = config.model.weights;

    return {
        predict(state: MatchState, triggerEventId?: string, triggerEventType?: string): Prediction {
            const features = extractFeatures(state);
            const startTime = performance.now();

            // Calculate individual factors
            const scoreAdvantage = calculateScoreAdvantage(features);
            const momentumAdvantage = calculateMomentumAdvantage(features);
            const economyAdvantage = calculateEconomyAdvantage(features);
            const aliveAdvantage = calculateAliveAdvantage(features);

            // Weighted combination
            const rawAdvantage =
                weights.score * scoreAdvantage +
                weights.momentum * momentumAdvantage +
                weights.economy * economyAdvantage +
                weights.alive * aliveAdvantage;

            // Convert to probability using sigmoid
            const pTeamAWin = sigmoid(rawAdvantage * 2); // Scale for better spread
            const pTeamBWin = 1 - pTeamAWin;

            // Calculate confidence based on how decisive the factors are
            const confidence = calculateConfidence(features, rawAdvantage);

            const latencyMs = performance.now() - startTime;

            logger.debug('Prediction calculated', {
                match_id: state.match_id,
                p_a: pTeamAWin.toFixed(3),
                p_b: pTeamBWin.toFixed(3),
                confidence: confidence.toFixed(3),
                latency_ms: latencyMs.toFixed(2),
            });

            return {
                match_id: state.match_id,
                map_id: state.map_id,
                round_no: state.current_round,
                ts_calc: new Date().toISOString(),
                model_version: config.model.version,
                team_a_id: state.team_a_id,
                team_b_id: state.team_b_id,
                p_team_a_win: round(pTeamAWin, 4),
                p_team_b_win: round(pTeamBWin, 4),
                confidence: round(confidence, 4),
                trigger_event_id: triggerEventId,
                trigger_event_type: triggerEventType,
                features,
            };
        },
    };
}

/**
 * Extract features from match state
 */
function extractFeatures(state: MatchState): PredictionFeatures {
    const roundsPlayed = state.team_a_score + state.team_b_score;
    const history = state.round_history;

    // Calculate momentum from last 5 rounds
    let momentum = 0;
    let streakTeam: 'A' | 'B' | 'none' = 'none';
    let streakLength = 0;

    if (history.length > 0) {
        const recentRounds = history.slice(-5);
        const teamAWins = recentRounds.filter(r => r.winner === 'A').length;
        const teamBWins = recentRounds.length - teamAWins;
        momentum = (teamAWins - teamBWins) / recentRounds.length;

        // Calculate streak
        for (let i = history.length - 1; i >= 0; i--) {
            const round = history[i]!;
            if (streakTeam === 'none') {
                streakTeam = round.winner;
                streakLength = 1;
            } else if (round.winner === streakTeam) {
                streakLength++;
            } else {
                break;
            }
        }
    }

    // Economy advantage
    const economyAdvantage = state.team_a_econ > state.team_b_econ
        ? 'A'
        : (state.team_b_econ > state.team_a_econ ? 'B' : 'even');

    // Current half
    const currentHalf = roundsPlayed < CS2.HALF_ROUNDS
        ? 1
        : (roundsPlayed < CS2.REGULATION_ROUNDS ? 2 : 'overtime');

    return {
        team_a_score: state.team_a_score,
        team_b_score: state.team_b_score,
        rounds_played: roundsPlayed,
        team_a_kills: state.team_a_kills_total,
        team_b_kills: state.team_b_kills_total,
        team_a_econ: state.team_a_econ,
        team_b_econ: state.team_b_econ,
        economy_advantage: economyAdvantage,
        momentum,
        streak_team: streakTeam,
        streak_length: streakLength,
        current_half: currentHalf,
        team_a_side: state.team_a_side,
    };
}

/**
 * Score-based advantage (-1 to 1)
 */
function calculateScoreAdvantage(features: PredictionFeatures): number {
    const roundsToWin = CS2.ROUNDS_TO_WIN;
    const aRemaining = roundsToWin - features.team_a_score;
    const bRemaining = roundsToWin - features.team_b_score;

    if (aRemaining === 0) return 1; // A already won
    if (bRemaining === 0) return -1; // B already won

    // Advantage based on how close each team is to winning
    return (bRemaining - aRemaining) / roundsToWin;
}

/**
 * Momentum-based advantage (-1 to 1)
 */
function calculateMomentumAdvantage(features: PredictionFeatures): number {
    // Momentum is already -1 to 1
    let advantage = features.momentum;

    // Boost for streaks
    if (features.streak_length >= 3) {
        const streakBoost = Math.min(features.streak_length * 0.1, 0.3);
        advantage += features.streak_team === 'A' ? streakBoost : -streakBoost;
    }

    return Math.max(-1, Math.min(1, advantage));
}

/**
 * Economy-based advantage (-1 to 1)
 */
function calculateEconomyAdvantage(features: PredictionFeatures): number {
    const diff = features.team_a_econ - features.team_b_econ;
    const totalEcon = features.team_a_econ + features.team_b_econ;

    if (totalEcon === 0) return 0;

    // Normalize by total economy
    return diff / totalEcon;
}

/**
 * Alive players advantage for current round (-1 to 1)
 * Only relevant during live rounds
 */
function calculateAliveAdvantage(features: PredictionFeatures): number {
    // This feature would be used if we had alive count in features
    // For now, return neutral
    return 0;
}

/**
 * Calculate confidence score (0 to 1)
 */
function calculateConfidence(features: PredictionFeatures, advantage: number): number {
    // More rounds played = more data = higher confidence
    const roundConfidence = Math.min(features.rounds_played / 10, 1);

    // Stronger advantage = higher confidence
    const advantageConfidence = Math.abs(advantage);

    // Base confidence
    let confidence = 0.5 + (roundConfidence * 0.25) + (advantageConfidence * 0.25);

    // Cap at 0.95 - never be completely certain
    return Math.min(0.95, Math.max(0.3, confidence));
}

/**
 * Sigmoid function for probability conversion
 */
function sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x));
}

/**
 * Round to decimal places
 */
function round(value: number, decimals: number): number {
    const multiplier = Math.pow(10, decimals);
    return Math.round(value * multiplier) / multiplier;
}
