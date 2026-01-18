-- ============================================
-- CS2 Live Analytics - ClickHouse Schema
-- ============================================

-- Create database
CREATE DATABASE IF NOT EXISTS esports;

USE esports;

-- ============================================
-- 1. Raw Events Table (Audit + Replay)
-- ============================================
-- Immutable log of all incoming events
-- Used for: debugging, replay, backfill, audit

CREATE TABLE IF NOT EXISTS cs2_events_raw
(
    -- Partitioning & time
    date Date DEFAULT toDate(ts_event),
    ts_event DateTime64(3, 'UTC'),
    ts_ingest DateTime64(3, 'UTC') DEFAULT now64(3),
    
    -- Event identity
    event_id UUID,
    source LowCardinality(String),
    seq_no UInt64,
    
    -- Match context
    match_id UUID,
    map_id UUID,
    round_no UInt16,
    
    -- Event data
    type LowCardinality(String),
    payload String, -- JSON as string for flexibility
    
    -- Processing metadata
    processed_at DateTime64(3, 'UTC') DEFAULT now64(3),
    processor_version LowCardinality(String) DEFAULT 'v1'
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(date)
ORDER BY (match_id, map_id, ts_event, seq_no, event_id)
TTL date + INTERVAL 90 DAY DELETE
SETTINGS index_granularity = 8192;

-- Index for quick event_id lookups (deduplication)
ALTER TABLE cs2_events_raw ADD INDEX idx_event_id event_id TYPE bloom_filter GRANULARITY 4;

-- ============================================
-- 2. Predictions Time-Series
-- ============================================
-- Stores every prediction update for auditing
-- and historical analysis of prediction accuracy

CREATE TABLE IF NOT EXISTS cs2_predictions
(
    date Date DEFAULT toDate(ts_calc),
    ts_calc DateTime64(3, 'UTC'),
    
    match_id UUID,
    map_id UUID,
    round_no UInt16,
    
    model_version LowCardinality(String),
    
    team_a_id UUID,
    team_b_id UUID,
    
    -- Probabilities
    p_team_a_win Float32,
    p_team_b_win Float32,
    confidence Float32,
    
    -- Feature snapshot (for debugging model)
    features String, -- JSON with key features used
    
    -- Trigger event
    trigger_event_id UUID,
    trigger_event_type LowCardinality(String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(date)
ORDER BY (match_id, map_id, ts_calc)
TTL date + INTERVAL 180 DAY DELETE
SETTINGS index_granularity = 4096;

-- ============================================
-- 3. Round Metrics (Aggregated per round)
-- ============================================
-- Stores computed metrics per round
-- ReplacingMergeTree keeps latest version per key

CREATE TABLE IF NOT EXISTS cs2_round_metrics
(
    date Date DEFAULT toDate(ts_calc),
    ts_calc DateTime64(3, 'UTC'),
    
    match_id UUID,
    map_id UUID,
    round_no UInt16,
    
    team_a_id UUID,
    team_b_id UUID,
    
    -- Round state
    round_winner LowCardinality(String) DEFAULT '', -- 'A', 'B', or ''
    round_type LowCardinality(String) DEFAULT '',   -- 'pistol', 'eco', 'force', 'full'
    
    -- Kill metrics
    team_a_kills UInt16 DEFAULT 0,
    team_b_kills UInt16 DEFAULT 0,
    team_a_headshots UInt16 DEFAULT 0,
    team_b_headshots UInt16 DEFAULT 0,
    
    -- Economy
    team_a_econ Int32 DEFAULT 0,
    team_b_econ Int32 DEFAULT 0,
    
    -- Computed metrics
    momentum Float32 DEFAULT 0.0,           -- -1.0 to 1.0 (negative = B momentum)
    clutch_index Float32 DEFAULT 0.0,       -- 0.0 to 1.0
    economy_pressure Float32 DEFAULT 0.0,   -- 0.0 to 1.0
    
    -- Player highlights
    first_blood_player_id Nullable(String),
    first_blood_team LowCardinality(String) DEFAULT '',
    clutch_player_id Nullable(String),
    mvp_player_id Nullable(String)
)
ENGINE = ReplacingMergeTree(ts_calc)
PARTITION BY toYYYYMM(date)
ORDER BY (match_id, map_id, round_no)
TTL date + INTERVAL 90 DAY DELETE
SETTINGS index_granularity = 2048;

-- ============================================
-- 4. Match Metrics (Aggregated per match/map)
-- ============================================

CREATE TABLE IF NOT EXISTS cs2_match_metrics
(
    date Date DEFAULT toDate(ts_calc),
    ts_calc DateTime64(3, 'UTC'),
    
    match_id UUID,
    map_id Nullable(UUID), -- NULL for overall match
    
    team_a_id UUID,
    team_b_id UUID,
    
    -- Score
    team_a_rounds UInt16 DEFAULT 0,
    team_b_rounds UInt16 DEFAULT 0,
    
    -- Aggregated stats
    team_a_total_kills UInt32 DEFAULT 0,
    team_b_total_kills UInt32 DEFAULT 0,
    
    team_a_hs_percentage Float32 DEFAULT 0.0,
    team_b_hs_percentage Float32 DEFAULT 0.0,
    
    -- Win rates
    team_a_ct_rounds UInt16 DEFAULT 0,
    team_a_t_rounds UInt16 DEFAULT 0,
    team_b_ct_rounds UInt16 DEFAULT 0,
    team_b_t_rounds UInt16 DEFAULT 0,
    
    -- Trend metrics
    current_momentum Float32 DEFAULT 0.0,
    avg_round_duration_sec Float32 DEFAULT 0.0,
    
    -- Match state
    status LowCardinality(String) DEFAULT 'live' -- 'live', 'finished', 'paused'
)
ENGINE = ReplacingMergeTree(ts_calc)
PARTITION BY toYYYYMM(date)
ORDER BY (match_id, map_id)
TTL date + INTERVAL 180 DAY DELETE;

-- ============================================
-- 5. Player Stats (per match)
-- ============================================

CREATE TABLE IF NOT EXISTS cs2_player_stats
(
    date Date DEFAULT toDate(ts_calc),
    ts_calc DateTime64(3, 'UTC'),
    
    match_id UUID,
    map_id UUID,
    player_id String,
    team_id UUID,
    
    -- Core stats
    kills UInt16 DEFAULT 0,
    deaths UInt16 DEFAULT 0,
    assists UInt16 DEFAULT 0,
    headshots UInt16 DEFAULT 0,
    
    -- Advanced
    adr Float32 DEFAULT 0.0,  -- Average Damage per Round
    kast Float32 DEFAULT 0.0, -- Kill/Assist/Survived/Traded %
    rating Float32 DEFAULT 0.0,
    
    -- Impact
    first_kills UInt16 DEFAULT 0,
    first_deaths UInt16 DEFAULT 0,
    clutches_won UInt16 DEFAULT 0,
    clutches_played UInt16 DEFAULT 0,
    
    -- Economy
    total_damage UInt32 DEFAULT 0,
    utility_damage UInt32 DEFAULT 0
)
ENGINE = ReplacingMergeTree(ts_calc)
PARTITION BY toYYYYMM(date)
ORDER BY (match_id, map_id, player_id)
TTL date + INTERVAL 90 DAY DELETE;

-- ============================================
-- 6. Materialized Views for Real-time Aggregates
-- ============================================

-- MV: Count kills per round (feeds cs2_round_metrics)
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_round_kills
TO cs2_round_metrics
AS
SELECT
    toDate(ts_event) AS date,
    max(ts_event) AS ts_calc,
    match_id,
    map_id,
    round_no,
    
    toUUID(JSONExtractString(payload, 'team_a_id')) AS team_a_id,
    toUUID(JSONExtractString(payload, 'team_b_id')) AS team_b_id,
    
    '' AS round_winner,
    '' AS round_type,
    
    countIf(type = 'kill' AND JSONExtractString(payload, 'killer_team') = 'A') AS team_a_kills,
    countIf(type = 'kill' AND JSONExtractString(payload, 'killer_team') = 'B') AS team_b_kills,
    countIf(type = 'kill' AND JSONExtractString(payload, 'killer_team') = 'A' AND JSONExtractBool(payload, 'is_headshot')) AS team_a_headshots,
    countIf(type = 'kill' AND JSONExtractString(payload, 'killer_team') = 'B' AND JSONExtractBool(payload, 'is_headshot')) AS team_b_headshots,
    
    0 AS team_a_econ,
    0 AS team_b_econ,
    0.0 AS momentum,
    0.0 AS clutch_index,
    0.0 AS economy_pressure,
    
    NULL AS first_blood_player_id,
    '' AS first_blood_team,
    NULL AS clutch_player_id,
    NULL AS mvp_player_id
FROM cs2_events_raw
WHERE type IN ('kill', 'round_start', 'round_end')
GROUP BY date, match_id, map_id, round_no, team_a_id, team_b_id;

-- ============================================
-- 7. Useful Queries (Examples for API)
-- ============================================

-- Get latest prediction for a match
-- SELECT * FROM cs2_predictions
-- WHERE match_id = {match_id:UUID}
-- ORDER BY ts_calc DESC
-- LIMIT 1;

-- Get round-by-round metrics
-- SELECT round_no, team_a_kills, team_b_kills, momentum
-- FROM cs2_round_metrics FINAL
-- WHERE match_id = {match_id:UUID}
-- ORDER BY round_no ASC;

-- Get prediction history (for charts)
-- SELECT ts_calc, p_team_a_win, p_team_b_win, confidence
-- FROM cs2_predictions
-- WHERE match_id = {match_id:UUID}
-- ORDER BY ts_calc ASC;

-- Event count by type (debugging)
-- SELECT type, count() AS cnt
-- FROM cs2_events_raw
-- WHERE match_id = {match_id:UUID}
-- GROUP BY type
-- ORDER BY cnt DESC;
