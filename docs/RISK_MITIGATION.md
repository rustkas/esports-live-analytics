# Risk Mitigation Roadmap

## Current State Assessment

### ✅ What's Already Production-Grade
- Hot/cold path separation (Redis state + ClickHouse async)
- Idempotency via event_id deduplication
- Sharding strategy by (match_id, map_id)
- Observability from day one (Prometheus + Grafana)
- Comprehensive documentation

### ⚠️ Critical Risks to Address

---

## Risk 1: Event Ordering Not Guaranteed

**Problem**: BullMQ with multiple workers doesn't guarantee strict ordering within a shard.

**Solution**: Redis Streams with Consumer Groups

```
                          ┌─────────────────┐
                          │  Redis Streams  │
                          │                 │
   events:match:{id}:     │ ┌─────────────┐ │
   map:{id}               │ │  Stream Key │ │ ◄── One stream per shard
                          │ └─────────────┘ │
                          │        │        │
                          │        ▼        │
                          │ ┌─────────────┐ │
                          │ │   Consumer  │ │ ◄── Single consumer per stream
                          │ │    Group    │ │     guarantees ordering
                          │ └─────────────┘ │
                          └─────────────────┘
```

**Implementation**:
- [ ] Create `StreamManager` in shared package
- [ ] Migrate from BullMQ to Redis Streams  
- [ ] One consumer per (match_id, map_id) stream
- [ ] Automatic stream cleanup after match ends

**Files to modify**:
- `services/ingestion/src/queue.ts` → `stream.ts`
- `services/state-consumer/src/index.ts`

---

## Risk 2: Exactly-Once Semantics for Aggregates

**Problem**: At-least-once delivery will cause duplicate aggregates.

**Solution**: 
1. Never write aggregates directly — use MVs from raw events
2. Use ReplacingMergeTree with (match_id, map_id, round_no) as ORDER BY
3. Always query with `FINAL` or use dedup in queries

**Current ClickHouse Schema Review**:
```sql
-- ✅ cs2_events_raw: OK (raw, immutable, dedup by event_id)
-- ✅ cs2_predictions: OK (time-series, append-only)
-- ⚠️ cs2_round_metrics: NEEDS REVIEW (should be MV from raw)
-- ⚠️ cs2_match_metrics: NEEDS REVIEW (should be MV from raw)
```

**Implementation**:
- [ ] Convert cs2_round_metrics to MV
- [ ] Convert cs2_match_metrics to MV
- [ ] Add version column for ReplacingMergeTree
- [ ] Always use FINAL in analytics queries

---

## Risk 3: Latency Not Measured E2E

**Problem**: No visibility into end-to-end latency budget.

**Solution**: Distributed tracing with correlation IDs

```
Event Flow with Tracing:
┌─────────┐    ┌─────────┐    ┌──────────┐    ┌───────────┐
│ Ingest  │───▶│ Stream  │───▶│  State   │───▶│ Predictor │
│ ts_in   │    │ ts_queue│    │ ts_state │    │ ts_predict│
└─────────┘    └─────────┘    └──────────┘    └───────────┘
     │                                              │
     └──────────────────────────────────────────────┘
                   e2e_latency_ms
```

**Metrics to Add**:
```prometheus
# End-to-end latency
e2e_latency_ms{event_type, match_id} histogram

# Per-stage latency
stage_latency_ms{stage="ingest|queue|state|predict"} histogram

# SLO tracking
latency_slo_violations_total{slo="500ms"} counter
```

**Implementation**:
- [ ] Add TracingContext to shared package
- [ ] Propagate trace_id through all stages
- [ ] Add e2e latency histogram
- [ ] Create SLO dashboard in Grafana

---

## Risk 4: B2B API Not Production-Ready

**Problem**: No versioning, no stable contracts, no replay/audit.

**Solution**: API Gateway enhancements

### API Versioning
```
/api/v1/matches
/api/v1/predictions
/api/v2/matches (future)
```

### Stable Contracts
- OpenAPI/Swagger spec
- JSON Schema for events
- Changelog for breaking changes

### Replay/Audit Endpoints
```
GET /api/v1/replay/{match_id}           # Replay all events
GET /api/v1/audit/{match_id}            # Audit log
GET /api/v1/events/{match_id}?from=&to= # Event range query
```

**Implementation**:
- [ ] Version routes in API Gateway
- [ ] Add OpenAPI spec generation
- [ ] Create replay endpoint
- [ ] Add audit logging middleware

---

## Risk 5: B2B Security Missing

**Problem**: No authentication, no rate limiting, no audit trail.

**Solution**: Security Layer

### API Key Management
```typescript
interface ApiClient {
  client_id: string;
  api_key_hash: string;      // bcrypt
  rate_limit_per_min: number;
  allowed_ips?: string[];
  permissions: string[];     // ['read:matches', 'read:predictions']
  webhook_secret?: string;   // for HMAC signatures
}
```

### Request Flow
```
Request
   │
   ▼
┌──────────────┐
│ Rate Limiter │ ← Redis sliding window
└──────────────┘
   │
   ▼
┌──────────────┐
│   API Key    │ ← Validate + check permissions
│  Validator   │
└──────────────┘
   │
   ▼
┌──────────────┐
│    Audit     │ ← Log to ClickHouse
│    Logger    │
└──────────────┘
   │
   ▼
  Handler
```

### Webhook HMAC Signing
```typescript
// For outgoing webhooks to clients
const signature = crypto
  .createHmac('sha256', client.webhook_secret)
  .update(JSON.stringify(payload))
  .digest('hex');

headers['X-Signature'] = `sha256=${signature}`;
```

**Implementation**:
- [ ] Create AuthMiddleware
- [ ] Implement sliding window rate limiter
- [ ] Add IP allowlist checking
- [ ] Create audit log table in ClickHouse
- [ ] Add HMAC signature for webhooks

---

## Implementation Priority

### Phase 1: Critical (Week 1)
1. Redis Streams for ordering
2. Fix ClickHouse MVs for exactly-once
3. E2E latency metrics

### Phase 2: B2B Ready (Week 2)
4. API versioning
5. API Key auth + rate limiting
6. Audit logging

### Phase 3: Production Hardening (Week 3)
7. OpenAPI spec
8. Replay endpoints
9. HMAC webhooks
10. Load testing with k6

---

## Testing Strategy

### Unit Tests
- Stream ordering verification
- Rate limiter accuracy
- HMAC signature validation

### Integration Tests
- E2E latency under load
- Failover scenarios
- Consumer group recovery

### Load Tests (k6)
```javascript
// Scenarios
export const options = {
  scenarios: {
    sustained_load: {
      executor: 'constant-arrival-rate',
      rate: 1000, // 1000 events/sec
      duration: '5m',
    },
    burst: {
      executor: 'ramping-arrival-rate',
      startRate: 100,
      stages: [
        { target: 5000, duration: '30s' }, // spike to 5k/s
        { target: 100, duration: '1m' },   // recover
      ],
    },
  },
};
```

### SLO Verification
- p95 < 300ms
- p99 < 500ms
- Error rate < 0.1%
- No event loss (verify with checksums)
