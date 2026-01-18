/**
 * API Types
 * Request/Response types for REST and GraphQL APIs
 */

// ============================================
// Common Response Wrappers
// ============================================

export interface ApiResponse<T> {
    success: boolean;
    data?: T;
    error?: ApiError;
    meta?: ResponseMeta;
}

export interface ApiError {
    code: string;
    message: string;
    details?: Record<string, unknown>;
}

export interface ResponseMeta {
    timestamp: string;
    request_id?: string;
    latency_ms?: number;
}

// ============================================
// Pagination
// ============================================

export interface PaginationParams {
    limit?: number;
    offset?: number;
    cursor?: string;
}

export interface PaginatedResponse<T> {
    items: T[];
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
    next_cursor?: string;
}

// ============================================
// Match API
// ============================================

export interface MatchListParams extends PaginationParams {
    status?: 'scheduled' | 'live' | 'finished';
    team_id?: string;
    tournament?: string;
    from_date?: string;
    to_date?: string;
}

export interface MatchResponse {
    id: string;
    tournament_name: string;
    format: 'bo1' | 'bo3' | 'bo5';
    status: 'scheduled' | 'live' | 'finished' | 'cancelled';
    scheduled_at?: string;
    started_at?: string;
    finished_at?: string;

    team_a: TeamSummary;
    team_b: TeamSummary;

    team_a_maps_won: number;
    team_b_maps_won: number;
    winner_id?: string;

    current_map?: MapSummary;
    maps: MapSummary[];
}

export interface TeamSummary {
    id: string;
    name: string;
    short_name: string;
    logo_url?: string;
}

export interface MapSummary {
    id: string;
    map_name: string;
    map_number: number;
    status: 'scheduled' | 'live' | 'finished';
    team_a_score: number;
    team_b_score: number;
    current_round?: number;
    winner_id?: string;
}

// ============================================
// Stats API
// ============================================

export interface MatchStatsRequest {
    match_id: string;
    map_id?: string; // optional: specific map or overall
}

export interface MatchStatsResponse {
    match_id: string;
    map_id?: string;

    team_a: TeamStats;
    team_b: TeamStats;

    rounds: RoundStats[];

    updated_at: string;
}

export interface TeamStats {
    id: string;
    name: string;

    rounds_won: number;
    total_kills: number;
    total_deaths: number;
    total_assists: number;

    hs_percentage: number;
    first_kill_rate: number;
    clutch_wins: number;

    economy_avg: number;
    adr: number;

    players: PlayerStats[];
}

export interface PlayerStats {
    id: string;
    nickname: string;

    kills: number;
    deaths: number;
    assists: number;
    headshots: number;

    adr: number;
    kast: number;
    rating: number;

    first_kills: number;
    first_deaths: number;
    clutches_won: number;
    clutches_played: number;
}

export interface RoundStats {
    round_no: number;
    winner: 'A' | 'B';
    win_reason: string;

    team_a_kills: number;
    team_b_kills: number;
    team_a_alive: number;
    team_b_alive: number;

    first_blood_player_id?: string;
    first_blood_team?: 'A' | 'B';

    duration_sec: number;
}

// ============================================
// Prediction API
// ============================================

export interface PredictionRequest {
    match_id: string;
    map_id?: string;
}

export interface PredictionResponse {
    match_id: string;
    map_id: string;
    round_no: number;

    team_a: {
        id: string;
        name: string;
        win_probability: number;
    };
    team_b: {
        id: string;
        name: string;
        win_probability: number;
    };

    confidence: number;
    model_version: string;
    calculated_at: string;
}

export interface PredictionHistoryRequest {
    match_id: string;
    map_id?: string;
    from_round?: number;
    to_round?: number;
}

export interface PredictionHistoryResponse {
    match_id: string;
    map_id: string;

    history: Array<{
        round_no: number;
        ts_calc: string;
        team_a_win_probability: number;
        team_b_win_probability: number;
        confidence: number;
        trigger_event?: string;
    }>;
}

// ============================================
// Live Updates (WebSocket/Subscriptions)
// ============================================

export interface LiveUpdate {
    type: 'prediction' | 'score' | 'event' | 'state';
    match_id: string;
    map_id?: string;
    timestamp: string;
    data: unknown;
}

export interface PredictionUpdate {
    match_id: string;
    map_id: string;
    round_no: number;
    team_a_win_probability: number;
    team_b_win_probability: number;
    confidence: number;
    trigger_event_type: string;
}

export interface ScoreUpdate {
    match_id: string;
    map_id: string;
    team_a_score: number;
    team_b_score: number;
    current_round: number;
}

// ============================================
// Health & Metrics
// ============================================

export interface HealthResponse {
    status: 'healthy' | 'degraded' | 'unhealthy';
    version: string;
    uptime_seconds: number;
    checks: {
        name: string;
        status: 'pass' | 'warn' | 'fail';
        latency_ms?: number;
        message?: string;
    }[];
}

export interface MetricsResponse {
    events_processed: number;
    predictions_calculated: number;
    active_matches: number;
    queue_depth: number;
    avg_latency_ms: number;
    error_rate: number;
}
