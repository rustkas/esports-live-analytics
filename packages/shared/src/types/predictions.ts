/**
 * Prediction Types
 * Structures for win probability predictions and analytics
 */

// ============================================
// Prediction Output
// ============================================

export interface Prediction {
    /** Match identifier */
    match_id: string;

    /** Map identifier (for map-level predictions) */
    map_id: string;

    /** Current round number */
    round_no: number;

    /** When prediction was calculated */
    ts_calc: string;

    /** Model version used */
    model_version: string;

    /** Team A identifier */
    team_a_id: string;

    /** Team B identifier */
    team_b_id: string;

    /** Probability Team A wins (0-1) */
    p_team_a_win: number;

    /** Probability Team B wins (0-1) */
    p_team_b_win: number;

    /** Confidence score (0-1) */
    confidence: number;

    /** Event that triggered this prediction */
    trigger_event_id?: string;
    trigger_event_type?: string;

    /** Features used (for debugging/audit) */
    features?: PredictionFeatures;

    /** State version this prediction is based on */
    state_version: number;
}

// ============================================
// Features used for prediction
// ============================================

export interface PredictionFeatures {
    // Score
    team_a_score: number;
    team_b_score: number;
    rounds_played: number;

    // Round metrics
    team_a_kills: number;
    team_b_kills: number;

    // Economy
    team_a_econ: number;
    team_b_econ: number;
    economy_advantage: 'A' | 'B' | 'even';

    // Momentum (last N rounds)
    momentum: number; // -1 to 1 (negative = B)
    streak_team: 'A' | 'B' | 'none';
    streak_length: number;

    // Map half
    current_half: 1 | 2 | 'overtime';
    team_a_side: 'CT' | 'T';

    // Historical (if available)
    team_a_history_win_rate?: number;
    team_b_history_win_rate?: number;
    head_to_head_a_wins?: number;
    head_to_head_b_wins?: number;

    // Map-specific
    team_a_map_win_rate?: number;
    team_b_map_win_rate?: number;
}

// ============================================
// Prediction Request
// ============================================

export interface PredictRequest {
    match_id: string;
    map_id: string;
    round_no: number;

    /** Current state (from state-consumer) */
    state: MatchState;

    /** Trigger event */
    trigger_event_id?: string;
    trigger_event_type?: string;
}

// ============================================
// Match State (for prediction input)
// ============================================

export interface MatchState {
    match_id: string;
    map_id: string;

    team_a_id: string;
    team_b_id: string;

    // Score
    team_a_score: number;
    team_b_score: number;
    current_round: number;

    // Current round state
    round_phase: 'warmup' | 'freeze' | 'live' | 'over';
    team_a_alive: number;
    team_b_alive: number;

    // Economy
    team_a_econ: number;
    team_b_econ: number;

    // Sides
    team_a_side: 'CT' | 'T';

    // Metrics
    team_a_kills_round: number;
    team_b_kills_round: number;
    team_a_kills_total: number;
    team_b_kills_total: number;

    // Bomb state
    bomb_planted: boolean;
    bomb_site?: 'A' | 'B';

    // Updates
    last_event_id: string;
    last_event_at: string;

    // History
    round_history: RoundResult[];

    // Versioning (monotonic)
    state_version: number;
}

export interface RoundResult {
    round_no: number;
    winner: 'A' | 'B';
    win_reason: string;
    team_a_kills: number;
    team_b_kills: number;
}

// ============================================
// Round Metrics (from analytics)
// ============================================

export interface RoundMetrics {
    match_id: string;
    map_id: string;
    round_no: number;

    team_a_kills: number;
    team_b_kills: number;
    team_a_headshots: number;
    team_b_headshots: number;

    team_a_econ: number;
    team_b_econ: number;

    momentum: number;
    clutch_index: number;
    economy_pressure: number;

    first_blood_team?: 'A' | 'B';
    round_winner?: 'A' | 'B';
}

// ============================================
// Match Metrics (aggregate)
// ============================================

export interface MatchMetrics {
    match_id: string;
    map_id?: string; // null for overall

    team_a_rounds: number;
    team_b_rounds: number;

    team_a_total_kills: number;
    team_b_total_kills: number;

    team_a_hs_percentage: number;
    team_b_hs_percentage: number;

    current_momentum: number;
    avg_round_duration_sec: number;

    status: 'live' | 'finished' | 'paused';
}

// ============================================
// Prediction History (for charts/analysis)
// ============================================

export interface PredictionPoint {
    ts_calc: string;
    round_no: number;
    p_team_a_win: number;
    p_team_b_win: number;
    confidence: number;
    trigger_event_type?: string;
}

export interface PredictionHistory {
    match_id: string;
    map_id: string;
    team_a_id: string;
    team_b_id: string;
    points: PredictionPoint[];
}
