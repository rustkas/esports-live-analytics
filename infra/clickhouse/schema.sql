-- ============================================================
-- CS2 Analytics ClickHouse Schema (Production-Ready)
-- ============================================================
-- This schema is designed for:
-- 1. High-throughput event ingestion (10k+ events/sec)
-- 2. Low-latency analytical queries
-- 3. Exactly-once semantics via deduplication
-- 4. Automatic aggregation via Materialized Views
-- ============================================================

-- ============================================================
-- SECTION 1: RAW EVENTS TABLE
-- The single source of truth for all events
-- ============================================================

CREATE TABLE IF NOT EXISTS cs2_events_raw
(
    -- Partition key
    date Date DEFAULT toDate(ts_event),
    
    -- Materialized columns for fast access/debug
    event_day Date MATERIALIZED toDate(ts_event),
    event_hour DateTime MATERIALIZED toStartOfHour(ts_event),
    ingest_partition UInt32 MATERIALIZED toYYYYMMDD(ts_ingest),
    
    -- Event identification
    event_id UUID,
    match_id UUID,
    map_id UUID,
    round_no UInt8,
    
    -- Timestamps
    ts_event DateTime64(3) CODEC(Delta, ZSTD(1)),
    ts_ingest DateTime64(3) DEFAULT now64(3) CODEC(Delta, ZSTD(1)),
    
    -- Event data
    type LowCardinality(String),
    source LowCardinality(String),
    seq_no UInt64 CODEC(DoubleDelta, ZSTD(1)),
    payload String CODEC(ZSTD(3)),  -- JSON compressed
    
    -- Tracing
    trace_id String DEFAULT '',
    
    -- Versioning for ReplacingMergeTree
    version UInt64 DEFAULT toUnixTimestamp64Milli(now64(3)) CODEC(DoubleDelta, ZSTD(1)),

    -- Indexes
    INDEX idx_event_id event_id TYPE tokenbf_v1(1024, 2, 0) GRANULARITY 4
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(date)
ORDER BY (match_id, map_id, round_no, ts_event, event_id)
TTL date + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- Index for fast lookups
ALTER TABLE cs2_events_raw ADD INDEX idx_type type TYPE set(100) GRANULARITY 4;
ALTER TABLE cs2_events_raw ADD INDEX idx_round round_no TYPE minmax GRANULARITY 1;

-- ============================================================
-- SECTION 1.5: PARSED EVENTS (Typed columns for analytics)
-- ============================================================

CREATE TABLE IF NOT EXISTS cs2_events_parsed
(
    date Date DEFAULT toDate(ts_event),
    ts_event DateTime64(3) CODEC(Delta, ZSTD(1)),
    match_id UUID,
    map_id UUID,
    round_no UInt8,
    event_id UUID,
    type LowCardinality(String),

    -- Kill specifics
    killer_team LowCardinality(String) DEFAULT '',
    victim_team LowCardinality(String) DEFAULT '',
    is_headshot UInt8 DEFAULT 0,
    weapon LowCardinality(String) DEFAULT '',

    -- Economy specifics
    team_a_econ UInt32 DEFAULT 0,
    team_b_econ UInt32 DEFAULT 0,
    team_a_equipment_value UInt32 DEFAULT 0,
    team_b_equipment_value UInt32 DEFAULT 0,

    -- Round End
    winner_team LowCardinality(String) DEFAULT '',
    win_reason LowCardinality(String) DEFAULT ''
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(date)
ORDER BY (match_id, map_id, round_no, ts_event)
TTL date + INTERVAL 180 DAY
SETTINGS index_granularity = 8192;

ALTER TABLE cs2_events_parsed ADD PROJECTION p_last_events
(
    SELECT *
    ORDER BY match_id, ts_event DESC
);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_events_parsed
TO cs2_events_parsed
AS SELECT
    toDate(ts_event) as date,
    ts_event,
    match_id,
    map_id,
    round_no,
    event_id,
    type,
    
    -- Kill
    JSONExtractString(payload, 'killer_team') as killer_team,
    JSONExtractString(payload, 'victim_team') as victim_team,
    JSONExtractBool(payload, 'is_headshot') as is_headshot,
    JSONExtractString(payload, 'weapon') as weapon,

    -- Economy
    JSONExtractUInt(payload, 'team_a_econ') as team_a_econ,
    JSONExtractUInt(payload, 'team_b_econ') as team_b_econ,
    JSONExtractUInt(payload, 'team_a_equipment_value') as team_a_equipment_value,
    JSONExtractUInt(payload, 'team_b_equipment_value') as team_b_equipment_value,

    -- Round End
    JSONExtractString(payload, 'winner_team') as winner_team,
    JSONExtractString(payload, 'win_reason') as win_reason

FROM cs2_events_raw
WHERE type IN ('kill', 'economy_update', 'round_end');

-- ============================================================
-- SECTION 2: PREDICTIONS TABLE
-- Time-series of predictions (append-only, no updates)
-- ============================================================

CREATE TABLE IF NOT EXISTS cs2_predictions
(
    date Date DEFAULT toDate(ts_calc),
    ts_calc DateTime64(3),
    
    match_id UUID,
    map_id UUID,
    round_no UInt8,
    
    model_version LowCardinality(String),
    
    team_a_id UUID,
    team_b_id UUID,
    
    p_team_a_win Float32,
    p_team_b_win Float32,
    confidence Float32,
    
    features String DEFAULT '{}',  -- JSON
    trigger_event_id String DEFAULT '',
    trigger_event_type LowCardinality(String) DEFAULT '',
    
    -- Versioning for upserts
    prediction_id UUID DEFAULT generateUUIDv4(),
    version UInt64 DEFAULT toUnixTimestamp64Milli(now64(3))
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(date)
ORDER BY (match_id, map_id, ts_calc, model_version)
TTL date + INTERVAL 180 DAY
SETTINGS index_granularity = 8192;

-- ============================================================
-- SECTION 3: MATERIALIZED VIEWS FOR AGGREGATES
-- Aggregates are computed FROM raw events, not written directly
-- This ensures exactly-once semantics
-- ============================================================

-- ------------------------------------------------------------
-- 3.1: Round Metrics (aggregated from kill events)
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cs2_round_metrics_store
(
    date Date,
    match_id UUID,
    map_id UUID,
    round_no UInt8,
    
    team_a_kills SimpleAggregateFunction(sum, UInt16),
    team_b_kills SimpleAggregateFunction(sum, UInt16),
    team_a_headshots SimpleAggregateFunction(sum, UInt16),
    team_b_headshots SimpleAggregateFunction(sum, UInt16),
    team_a_first_kills SimpleAggregateFunction(sum, UInt16),
    team_b_first_kills SimpleAggregateFunction(sum, UInt16),
    
    events_count SimpleAggregateFunction(sum, UInt32),
    
    -- Latest state (use max to get last value)
    team_a_score SimpleAggregateFunction(max, UInt8),
    team_b_score SimpleAggregateFunction(max, UInt8),
    round_winner LowCardinality(String),
    
    -- Timing
    first_event_ts SimpleAggregateFunction(min, DateTime64(3)),
    last_event_ts SimpleAggregateFunction(max, DateTime64(3)),
    
    -- Version for dedup
    version UInt64
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(date)
ORDER BY (match_id, map_id, round_no)
TTL date + INTERVAL 90 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_round_metrics
TO cs2_round_metrics_store
AS SELECT
    toDate(ts_event) AS date,
    match_id,
    map_id,
    round_no,
    
    -- Kill stats from payload
    sumIf(1, type = 'kill' AND JSONExtractString(payload, 'killer_team') = 'A') AS team_a_kills,
    sumIf(1, type = 'kill' AND JSONExtractString(payload, 'killer_team') = 'B') AS team_b_kills,
    sumIf(1, type = 'kill' AND JSONExtractString(payload, 'killer_team') = 'A' AND JSONExtractBool(payload, 'is_headshot')) AS team_a_headshots,
    sumIf(1, type = 'kill' AND JSONExtractString(payload, 'killer_team') = 'B' AND JSONExtractBool(payload, 'is_headshot')) AS team_b_headshots,
    sumIf(1, type = 'kill' AND JSONExtractString(payload, 'killer_team') = 'A' AND JSONExtractBool(payload, 'is_first_kill')) AS team_a_first_kills,
    sumIf(1, type = 'kill' AND JSONExtractString(payload, 'killer_team') = 'B' AND JSONExtractBool(payload, 'is_first_kill')) AS team_b_first_kills,
    
    count() AS events_count,
    
    -- Latest scores from round_end
    maxIf(JSONExtractUInt(payload, 'team_a_score'), type = 'round_end') AS team_a_score,
    maxIf(JSONExtractUInt(payload, 'team_b_score'), type = 'round_end') AS team_b_score,
    anyLastIf(JSONExtractString(payload, 'winner_team'), type = 'round_end') AS round_winner,
    
    min(ts_event) AS first_event_ts,
    max(ts_event) AS last_event_ts,
    
    max(toUnixTimestamp64Milli(ts_event)) AS version
    
FROM cs2_events_raw
GROUP BY date, match_id, map_id, round_no;

-- ------------------------------------------------------------
-- 3.2: Match Metrics (aggregated from all events)
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cs2_match_metrics_store
(
    date Date,
    match_id UUID,
    map_id UUID,
    
    total_rounds SimpleAggregateFunction(max, UInt8),
    team_a_rounds_won SimpleAggregateFunction(max, UInt8),
    team_b_rounds_won SimpleAggregateFunction(max, UInt8),
    
    total_kills SimpleAggregateFunction(sum, UInt32),
    team_a_kills SimpleAggregateFunction(sum, UInt32),
    team_b_kills SimpleAggregateFunction(sum, UInt32),
    
    total_headshots SimpleAggregateFunction(sum, UInt32),
    
    events_count SimpleAggregateFunction(sum, UInt64),
    
    match_start_ts SimpleAggregateFunction(min, DateTime64(3)),
    last_event_ts SimpleAggregateFunction(max, DateTime64(3)),
    
    status LowCardinality(String)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(date)
ORDER BY (match_id, map_id)
TTL date + INTERVAL 180 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_match_metrics
TO cs2_match_metrics_store
AS SELECT
    toDate(ts_event) AS date,
    match_id,
    map_id,
    
    max(round_no) AS total_rounds,
    maxIf(JSONExtractUInt(payload, 'team_a_score'), type = 'round_end') AS team_a_rounds_won,
    maxIf(JSONExtractUInt(payload, 'team_b_score'), type = 'round_end') AS team_b_rounds_won,
    
    countIf(type = 'kill') AS total_kills,
    countIf(type = 'kill' AND JSONExtractString(payload, 'killer_team') = 'A') AS team_a_kills,
    countIf(type = 'kill' AND JSONExtractString(payload, 'killer_team') = 'B') AS team_b_kills,
    
    countIf(type = 'kill' AND JSONExtractBool(payload, 'is_headshot')) AS total_headshots,
    
    count() AS events_count,
    
    min(ts_event) AS match_start_ts,
    max(ts_event) AS last_event_ts,
    
    if(countIf(type = 'match_end') > 0, 'finished',
       if(countIf(type = 'match_start') > 0, 'live', 'unknown')) AS status

FROM cs2_events_raw
GROUP BY date, match_id, map_id;

-- ------------------------------------------------------------
-- 3.3: Player Stats (aggregated from kill/hurt events)
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cs2_player_stats_store
(
    date Date,
    match_id UUID,
    map_id UUID,
    player_id UUID,
    team LowCardinality(String),
    
    kills SimpleAggregateFunction(sum, UInt16),
    deaths SimpleAggregateFunction(sum, UInt16),
    headshots SimpleAggregateFunction(sum, UInt16),
    first_kills SimpleAggregateFunction(sum, UInt16),
    damage_dealt SimpleAggregateFunction(sum, UInt32)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(date)
ORDER BY (match_id, map_id, player_id)
TTL date + INTERVAL 90 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_player_kills
TO cs2_player_stats_store
AS SELECT
    toDate(ts_event) AS date,
    match_id,
    map_id,
    JSONExtractString(payload, 'killer_player_id')::UUID AS player_id,
    JSONExtractString(payload, 'killer_team') AS team,
    
    count() AS kills,
    0 AS deaths,
    countIf(JSONExtractBool(payload, 'is_headshot')) AS headshots,
    countIf(JSONExtractBool(payload, 'is_first_kill')) AS first_kills,
    0 AS damage_dealt
    
FROM cs2_events_raw
WHERE type = 'kill'
GROUP BY date, match_id, map_id, player_id, team;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_player_deaths
TO cs2_player_stats_store
AS SELECT
    toDate(ts_event) AS date,
    match_id,
    map_id,
    JSONExtractString(payload, 'victim_player_id')::UUID AS player_id,
    JSONExtractString(payload, 'victim_team') AS team,
    
    0 AS kills,
    count() AS deaths,
    0 AS headshots,
    0 AS first_kills,
    0 AS damage_dealt
    
FROM cs2_events_raw
WHERE type = 'kill'
GROUP BY date, match_id, map_id, player_id, team;

-- ============================================================
-- SECTION 4: AUDIT LOG
-- For B2B API audit trail
-- ============================================================

CREATE TABLE IF NOT EXISTS api_audit_log
(
    timestamp DateTime64(3),
    date Date DEFAULT toDate(timestamp),
    
    client_id String,
    action LowCardinality(String),
    resource String,
    
    ip_address String,
    user_agent String DEFAULT '',
    
    status_code UInt16,
    latency_ms Float32,
    
    request_id UUID,
    metadata String DEFAULT '{}'
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(date)
ORDER BY (date, client_id, timestamp)
TTL date + INTERVAL 365 DAY
SETTINGS index_granularity = 8192;

-- ============================================================
-- SECTION 5: LATENCY TRACKING
-- For SLO monitoring
-- ============================================================

CREATE TABLE IF NOT EXISTS e2e_latency_log
(
    timestamp DateTime64(3),
    date Date DEFAULT toDate(timestamp),
    
    trace_id String,
    event_type LowCardinality(String),
    match_id UUID,
    
    -- Stage latencies
    ingest_latency_ms Float32,
    queue_latency_ms Float32,
    state_latency_ms Float32,
    predict_latency_ms Float32,
    
    e2e_latency_ms Float32,
    
    -- SLO tracking
    slo_500ms_met UInt8  -- 1 if e2e < 500ms
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(date)
ORDER BY (date, timestamp)
TTL date + INTERVAL 30 DAY;

-- View for SLO dashboard
CREATE VIEW IF NOT EXISTS v_latency_slo AS
SELECT
    toStartOfMinute(timestamp) AS minute,
    count() AS total_events,
    sum(slo_500ms_met) AS met_slo,
    (sum(slo_500ms_met) / count()) * 100 AS slo_percentage,
    quantile(0.50)(e2e_latency_ms) AS p50_ms,
    quantile(0.95)(e2e_latency_ms) AS p95_ms,
    quantile(0.99)(e2e_latency_ms) AS p99_ms,
    max(e2e_latency_ms) AS max_ms
FROM e2e_latency_log
WHERE date >= today() - 1
GROUP BY minute
ORDER BY minute DESC;

-- ============================================================
-- SECTION 6: HELPFUL VIEWS
-- ============================================================

-- Combined round metrics view (uses FINAL for dedup)
CREATE VIEW IF NOT EXISTS v_round_metrics AS
SELECT
    match_id,
    map_id,
    round_no,
    team_a_kills,
    team_b_kills,
    team_a_headshots,
    team_b_headshots,
    team_a_score,
    team_b_score,
    round_winner,
    dateDiff('second', first_event_ts, last_event_ts) AS round_duration_sec
FROM cs2_round_metrics_store FINAL
ORDER BY match_id, map_id, round_no;

-- Live match status
CREATE VIEW IF NOT EXISTS v_live_matches AS
SELECT
    match_id,
    map_id,
    team_a_rounds_won,
    team_b_rounds_won,
    total_kills,
    events_count,
    match_start_ts,
    last_event_ts,
    dateDiff('second', last_event_ts, now64(3)) AS seconds_since_last_event
FROM cs2_match_metrics_store FINAL
WHERE status = 'live'
    AND last_event_ts > now64(3) - INTERVAL 5 MINUTE
ORDER BY last_event_ts DESC;

-- ============================================================
-- 3.4 Player Round Stats (Granular)
-- ============================================================
CREATE TABLE IF NOT EXISTS cs2_player_round_stats
(
    date Date,
    match_id UUID,
    map_id UUID,
    round_no UInt8,
    player_id UUID,
    team LowCardinality(String),
    
    kills SimpleAggregateFunction(sum, UInt16),
    deaths SimpleAggregateFunction(sum, UInt16),
    assists SimpleAggregateFunction(sum, UInt16),
    damage SimpleAggregateFunction(sum, UInt32),
    headshots SimpleAggregateFunction(sum, UInt16)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(date)
ORDER BY (match_id, map_id, round_no, player_id)
TTL date + INTERVAL 180 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_player_round_stats
TO cs2_player_round_stats
AS SELECT
    toDate(ts_event) as date,
    match_id,
    map_id,
    round_no,
    JSONExtractString(payload, 'killer_player_id')::UUID as player_id,
    JSONExtractString(payload, 'killer_team') as team,
    count() as kills,
    0 as deaths,
    0 as assists,
    0 as damage,
    countIf(JSONExtractBool(payload, 'is_headshot')) as headshots
FROM cs2_events_raw
WHERE type = 'kill'
GROUP BY date, match_id, map_id, round_no, player_id, team

UNION ALL

SELECT
    toDate(ts_event) as date,
    match_id,
    map_id,
    round_no,
    JSONExtractString(payload, 'victim_player_id')::UUID as player_id,
    JSONExtractString(payload, 'victim_team') as team,
    0 as kills,
    count() as deaths,
    0 as assists,
    0 as damage,
    0 as headshots
FROM cs2_events_raw
WHERE type = 'kill'
GROUP BY date, match_id, map_id, round_no, player_id, team;

-- ============================================================
-- 3.5 Team Round Stats
-- ============================================================
CREATE TABLE IF NOT EXISTS cs2_team_round_stats
(
    date Date,
    match_id UUID,
    map_id UUID,
    round_no UInt8,
    team LowCardinality(String),
    
    equipment_value SimpleAggregateFunction(max, UInt32),
    money_start SimpleAggregateFunction(max, UInt32),
    util_damage SimpleAggregateFunction(sum, UInt32)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(date)
ORDER BY (match_id, map_id, round_no, team)
TTL date + INTERVAL 180 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_team_round_stats
TO cs2_team_round_stats
AS SELECT
    toDate(ts_event) as date,
    match_id,
    map_id,
    round_no,
    'A' as team, 
    maxIf(JSONExtractUInt(payload, 'team_a_equipment_value'), type='economy_update') as equipment_value,
    maxIf(JSONExtractUInt(payload, 'team_a_econ'), type='economy_update') as money_start,
    0 as util_damage
FROM cs2_events_raw
WHERE type = 'economy_update'
GROUP BY date, match_id, map_id, round_no, team

UNION ALL

SELECT
    toDate(ts_event) as date,
    match_id,
    map_id,
    round_no,
    'B' as team,
    maxIf(JSONExtractUInt(payload, 'team_b_equipment_value'), type='economy_update') as equipment_value,
    maxIf(JSONExtractUInt(payload, 'team_b_econ'), type='economy_update') as money_start,
    0 as util_damage
FROM cs2_events_raw
WHERE type = 'economy_update'
GROUP BY date, match_id, map_id, round_no, team;

-- ============================================================
-- 3.6 Match Timeline
-- ============================================================
CREATE TABLE IF NOT EXISTS cs2_match_timeline
(
    date Date,
    match_id UUID,
    minute DateTime,
    
    events_count SimpleAggregateFunction(sum, UInt32),
    kills_count SimpleAggregateFunction(sum, UInt32)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(date)
ORDER BY (match_id, minute)
TTL date + INTERVAL 180 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_match_timeline
TO cs2_match_timeline
AS SELECT
    toDate(ts_event) as date,
    match_id,
    toStartOfMinute(ts_event) as minute,
    count() as events_count,
    countIf(type = 'kill') as kills_count
FROM cs2_events_raw
GROUP BY date, match_id, minute;
