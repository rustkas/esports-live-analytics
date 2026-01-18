/**
 * Shared Constants
 */

// ============================================
// Queue Names
// ============================================

export const QUEUES = {
    EVENTS: 'events',
    EVENTS_DLQ: 'events:dlq',
    PREDICTIONS: 'predictions',
    NOTIFICATIONS: 'notifications',
} as const;

// ============================================
// Redis Keys
// ============================================

export const REDIS_KEYS = {
    // Match state: match:{match_id}
    matchState: (matchId: string) => `match:${matchId}`,

    // Map state: map:{map_id}
    mapState: (mapId: string) => `map:${mapId}`,

    // Latest prediction: prediction:{match_id}
    latestPrediction: (matchId: string) => `prediction:${matchId}`,

    // Event dedup: event:seen:{event_id}
    eventSeen: (eventId: string) => `event:seen:${eventId}`,

    // Pub/Sub channels
    matchUpdates: (matchId: string) => `updates:match:${matchId}`,
    predictionUpdates: (matchId: string) => `updates:prediction:${matchId}`,
} as const;

// ============================================
// CS2 Game Constants
// ============================================

export const CS2 = {
    // Regulation rounds
    REGULATION_ROUNDS: 24,
    ROUNDS_TO_WIN: 13,
    HALF_ROUNDS: 12,

    // Overtime
    OVERTIME_ROUNDS: 6,
    OVERTIME_HALF: 3,

    // Players
    PLAYERS_PER_TEAM: 5,

    // Economy
    STARTING_MONEY: 800,
    MAX_MONEY: 16000,
    WIN_BONUS_BASE: 3250,
    LOSS_BONUS_BASE: 1400,
    LOSS_BONUS_INCREMENT: 500,
    MAX_LOSS_BONUS: 3400,

    // Bomb
    BOMB_TIMER_SEC: 40,
    DEFUSE_TIME_NO_KIT: 10,
    DEFUSE_TIME_WITH_KIT: 5,

    // Round time
    ROUND_TIME_SEC: 115,
    FREEZE_TIME_SEC: 15,
} as const;

// ============================================
// Event Processing
// ============================================

export const PROCESSING = {
    // Event dedup TTL (seconds)
    EVENT_DEDUP_TTL_SEC: 3600, // 1 hour

    // Batch sizes
    CLICKHOUSE_BATCH_SIZE: 100,
    CLICKHOUSE_FLUSH_INTERVAL_MS: 1000,

    // Timeouts
    PREDICTION_TIMEOUT_MS: 50,
    API_TIMEOUT_MS: 5000,

    // Retries
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 1000,
} as const;

// ============================================
// API
// ============================================

export const API = {
    // Rate limiting
    DEFAULT_RATE_LIMIT_PER_MIN: 60,

    // Pagination
    DEFAULT_PAGE_SIZE: 20,
    MAX_PAGE_SIZE: 100,

    // Cache TTL (seconds)
    MATCH_CACHE_TTL: 5,
    STATS_CACHE_TTL: 10,
    PREDICTION_CACHE_TTL: 1,
} as const;

// ============================================
// Significant Event Types
// ============================================

export const SIGNIFICANT_EVENTS = [
    'round_start',
    'round_end',
    'kill',
    'bomb_planted',
    'bomb_defused',
    'bomb_exploded',
] as const;

// Check if event type triggers prediction recalculation
export function isPredictionTrigger(eventType: string): boolean {
    return SIGNIFICANT_EVENTS.includes(eventType as typeof SIGNIFICANT_EVENTS[number]);
}

// ============================================
// Service Level Objectives (SLO)
// ============================================

export const SLO = {
    // Latency targets (milliseconds)
    E2E_LATENCY_P95_MS: 500,
    E2E_LATENCY_P99_MS: 1000,
    E2E_LATENCY_WARNING_MS: 300,

    // Error rate targets (percentage)
    ERROR_RATE_MAX_PERCENT: 0.1,
    ERROR_RATE_WARNING_PERCENT: 0.05,

    // Availability target (percentage)
    AVAILABILITY_TARGET_PERCENT: 99.9,

    // Measurement windows (milliseconds)
    MEASUREMENT_WINDOW_MS: 5 * 60 * 1000, // 5 minutes

    // Latency budget per stage (milliseconds, p95)
    BUDGET: {
        INGESTION_MS: 20,
        STREAM_QUEUE_MS: 50,
        STATE_UPDATE_MS: 30,
        CLICKHOUSE_MS: 100,  // async
        PREDICTION_MS: 50,
        PUBSUB_MS: 10,
        BUFFER_MS: 240,
    },
} as const;

// Check if latency meets SLO
export function meetsLatencySLO(latencyMs: number): boolean {
    return latencyMs <= SLO.E2E_LATENCY_P95_MS;
}

// Get latency status
export function getLatencyStatus(p95LatencyMs: number): 'healthy' | 'warning' | 'critical' {
    if (p95LatencyMs <= SLO.E2E_LATENCY_WARNING_MS) return 'healthy';
    if (p95LatencyMs <= SLO.E2E_LATENCY_P95_MS) return 'warning';
    return 'critical';
}

// Get error rate status
export function getErrorRateStatus(errorRatePercent: number): 'healthy' | 'warning' | 'critical' {
    if (errorRatePercent <= SLO.ERROR_RATE_WARNING_PERCENT) return 'healthy';
    if (errorRatePercent <= SLO.ERROR_RATE_MAX_PERCENT) return 'warning';
    return 'critical';
}
