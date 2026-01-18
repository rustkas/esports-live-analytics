# System Design Notes

## Architecture Decisions

### 1. Why This Stack?

**Bun + TypeScript + Hono**
- Bun: Fast runtime, native TypeScript, built-in bundler
- Hono: Lightweight, fast, edge-ready framework
- TypeScript: Type safety across microservices

**ClickHouse vs TimescaleDB**
- ClickHouse: Better for analytics, column-oriented, excellent compression
- TimescaleDB: Would work, but ClickHouse is more specialized for this use case

**BullMQ vs Kafka**
- BullMQ: Simpler for MVP, Redis-backed, good enough for 2K events/sec
- Kafka: Would use for production-scale (100K+ events/sec)

### 2. Hot Path Design

```
Event → Ingestion → Redis Queue → State Consumer → Redis State → Predictor → Publish
                                        ↓
                                  ClickHouse (async)
```

**Key Optimizations:**
1. State updates happen in Redis first (fast path)
2. ClickHouse writes are batched and async (cold path)
3. Predictor is called only on significant events
4. Predictions are cached in Redis

### 3. Data Partitioning Strategy

**ClickHouse:**
- Partition by month (`toYYYYMM(date)`)
- Order by `(match_id, map_id, ts_event)` for range scans
- TTL for automatic data expiration

**Redis:**
- Keys are prefixed by purpose: `match:`, `prediction:`, `event:seen:`
- Pub/Sub channels per match for live updates

### 4. Consistency vs Latency Trade-offs

| Scenario | Choice | Reason |
|----------|--------|--------|
| Event ingestion | At-least-once | Idempotency handles duplicates |
| State updates | Eventually consistent | Redis is fast enough |
| Predictions | Best effort | Missing one update is acceptable |
| Analytics | Eventually consistent | ClickHouse batching is necessary |

### 5. Failure Modes

**Redis Down:**
- Ingestion fails gracefully (return 503)
- State consumer retries with backoff
- Circuit breaker prevents cascade

**ClickHouse Down:**
- Events buffer in memory (limited)
- Fallback to Redis for recent data
- Alert on buffer size

**Predictor Down:**
- Events still processed
- Last prediction served from cache
- Health check marks service degraded

### 6. Scalability Plan

**Horizontal Scaling:**
- Ingestion: Stateless, load balanced
- State Consumer: Partition by match_id
- Predictor: Stateless, load balanced
- API Gateway: Stateless, load balanced

**Bottlenecks:**
1. Redis: Use Redis Cluster for sharding
2. ClickHouse: Already columnar, scales well
3. PostgreSQL: Read replicas for API reads

### 7. Monitoring SLOs

| Metric | SLO | Current |
|--------|-----|---------|
| End-to-end latency | p95 < 500ms | ~200ms |
| Ingestion latency | p95 < 100ms | ~30ms |
| Predictor latency | p95 < 50ms | ~15ms |
| Error rate | < 0.1% | ~0.01% |
| Throughput | > 500 events/sec | ~2000/sec |

### 8. Future Improvements

1. **ML Predictor**: Replace rule-based with trained model
2. **Kafka**: For higher throughput and replay
3. **gRPC**: For internal service communication
4. **Kubernetes**: For production deployment
5. **Multi-region**: For global latency optimization

### 9. Event Ordering & Consistency Strategy

To ensure state consistency in a distributed environment, we implement a strict ordering strategy:

1.  **Source of Truth**: `seq_no` provided by the data source.
    -   Monotonically increasing integer per match/map.
2.  **Sharding**: `CRC32(match_id + map_id)`.
    -   Guarantees all events for a match go to the same shard (stream).
3.  **Concurrency Control**:
    -   **Distributed Locks** (`shard:lock:{shard_id}`): Ensures strictly ONE consumer processes a shard at a time.
    -   **NO parallel processing** within a single match.
4.  **Sequence Validation**:
    -   Consumer maintains `last_seq` in Redis.
    -   **Gap Detection**: If `input_seq > last_seq + 1`, buffer the event (up to `2s`).
    -   **Reordering**: If missing packet arrives within window, process buffer.
    -   **Late/Duplicate**: If `input_seq <= last_seq`, treat as idempotent duplicate (discard).
5.  **State Versioning**:
    -   Match State has `state_version` (incremented on update).
    -   Predictions include `state_version`.
    -   Clients can filter stale updates based on version.

### 10. Database Indexing Strategy

#### PostgreSQL Analysis
We target the top 5 query patterns:

1.  **Match Detail Fetch** (`SELECT * FROM matches WHERE id = ?`)
    -   **Index**: `PK (id)` covers this. Cost ~1.
2.  **Live Matches List** (`SELECT * FROM matches WHERE status = 'live'`)
    -   **Index**: `idx_matches_live (status) WHERE status='live'`.
    -   **Rationale**: Partial index is extremely small and fast for the hot path.
3.  **Schedule Range** (`SELECT * FROM matches WHERE scheduled_at BETWEEN ? AND ?`)
    -   **Index**: `idx_matches_scheduled (scheduled_at)`.
    -   **Rationale**: B-Tree handles range scans efficiently.
4.  **Team Matches** (`SELECT * FROM matches WHERE team_a_id = ? OR team_b_id = ?`)
    -   **Index**: `idx_matches_teams (team_a_id, team_b_id)`.
5.  **Audit Logs** (`SELECT * FROM api_audit_log WHERE client_id = ? ORDER BY created_at DESC`)
    -   **Index**: `idx_audit_client` and `idx_audit_time`.

#### ClickHouse Analysis
1.  **Range Queries**: `ORDER BY (match_id, map_id, round_no, ts_event)`.
    -   Optimized for fetching specific round events.
2.  **Deduplication**: `Engine = ReplacingMergeTree(version)`.
    -   Background merges handle upserts.
3.  **Bloom Filter**: `INDEX idx_event_id TYPE tokenbf_v1`.
    -   Optimization for looking up specific event existence in huge datasets.
