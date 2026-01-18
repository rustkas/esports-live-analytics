# `Esports live analytics`

Production-style backend demo: **low-latency live analytics & predictions** for CS2 matches (REST + GraphQL + Subscriptions), designed for **B2B integrations**.

Data products like this power predictive analytics and betting-grade feeds: ingest high-rate event streams, compute unique metrics, and publish live win probabilities.

---

## 🏗 Architecture

### Hot Path (<500ms)

```
[ Live Events Source ]
          │
          ▼
[ Ingestion Service ]  ─── validates + enqueues
          │
          ▼
[ Event Bus (BullMQ) ]
          │
   ┌──────┴──────┐
   ▼              ▼
[ State ]    [ Analytics ]
   │              │
   ▼              ▼
[ Redis ]   [ ClickHouse ]
   │
   ▼
[ Predictor ] ────▶ computes win probability (<50ms)
   │
   ▼
[ API Gateway ] ────▶ REST + GraphQL + WS subscriptions
```

### Cold Path (analytics/audit)

- Raw event log + aggregates in **ClickHouse**
- **Postgres** for metadata/config (teams, matches, model versions)

---

## 🧩 Services

| Service | Tech | Description |
|---------|------|-------------|
| `ingestion` | TS/Hono | HTTP intake + validation + idempotency + enqueue |
| `state-consumer` | TS | Ordered processing per match/map + Redis state |
| `analytics` | TS | ClickHouse materialized views + query endpoints |
| `predictor` | TS | Feature extraction + prediction + publish updates |
| `api-gateway` | TS/Hono | REST + GraphQL + WS subscriptions |

---

## 🛠 Tech Stack

- **Runtime:** Bun + TypeScript
- **Framework:** Hono (fast, lightweight)
- **Databases:**
  - PostgreSQL (metadata, config)
  - ClickHouse (events, analytics, time-series)
  - Redis (live state, cache, queues via BullMQ)
- **Queues:** BullMQ (Redis-backed)
- **API:** REST + GraphQL (graphql-yoga) + WebSocket subscriptions
- **Infra:** Docker Compose
- **Monitoring:** Prometheus + Grafana

---

## 🚀 Quick Start

### Prerequisites

- Docker + Docker Compose
- Bun (optional, for local development)

### Run everything

```bash
# Start infrastructure + services
docker compose up -d

# Apply ClickHouse schema
docker compose exec clickhouse clickhouse-client --multiquery < ./infra/clickhouse/schema.sql

# Apply Postgres migrations
docker compose exec postgres psql -U postgres -d esports -f /docker-entrypoint-initdb.d/init.sql
```

### Smoke Test

Send a kill event:

```bash
curl -sS -X POST http://localhost:8081/events \
  -H 'content-type: application/json' \
  -d '{
    "event_id":"00000000-0000-0000-0000-000000000001",
    "match_id":"11111111-1111-1111-1111-111111111111",
    "map_id":"22222222-2222-2222-2222-222222222222",
    "round_no":1,
    "ts_event":"2026-01-18T12:00:00.123Z",
    "type":"kill",
    "source":"demo",
    "seq_no":1,
    "payload":{
      "killer_player_id":"p1",
      "victim_player_id":"p2",
      "killer_team":"A",
      "weapon":"ak47",
      "is_headshot":true
    }
  }'
```

### Endpoints

| Endpoint | URL |
|----------|-----|
| Ingestion API | http://localhost:8081 |
| API Gateway (REST) | http://localhost:8080/api |
| GraphQL Playground | http://localhost:8080/graphql |
| Prometheus | http://localhost:9090 |
| Grafana | http://localhost:3000 |

### GraphQL Subscription Example

```graphql
subscription {
  predictionUpdated(matchId: "11111111-1111-1111-1111-111111111111") {
    tsCalc
    pTeamAWin
    pTeamBWin
    confidence
  }
}
```

---

## 📊 Data Model

### ClickHouse Tables

| Table | Purpose | Engine |
|-------|---------|--------|
| `cs2_events_raw` | Immutable audit log (TTL 90d) | MergeTree |
| `cs2_round_metrics` | Per-round metrics | ReplacingMergeTree |
| `cs2_predictions` | Prediction time-series (TTL 180d) | MergeTree |

### PostgreSQL Tables

- `matches` — match metadata
- `teams` — team info
- `players` — player profiles
- `model_versions` — predictor model versions
- `api_clients` — B2B API keys

### Redis Keys

- `match:{match_id}` — live match state
- `prediction:{match_id}` — cached latest prediction
- BullMQ queues for event processing

---

## 🔒 Reliability

- **At-least-once ingestion** with idempotency (`event_id`)
- **Ordering guaranteed per match/map** via sharding key
- **Replay support** — read `cs2_events_raw` and reprocess
- **Backpressure** — BullMQ rate limiting
- **Dead Letter Queue** — failed events stored for debugging

---

## 📈 Observability

### Prometheus Metrics

- `ingestion_events_total` — events received
- `ingestion_latency_ms` — intake latency (histogram)
- `predictor_latency_ms` — prediction calculation time
- `api_requests_total` — API requests by endpoint
- `queue_depth` — BullMQ queue size
- `error_total` — error count by service

### Grafana Dashboards

Pre-configured dashboards in `infra/grafana/dashboards/`:
- System Overview
- Latency Analysis
- Queue Health
- Error Budget

---

## 🎯 Performance Targets

| Metric | Target |
|--------|--------|
| End-to-end latency | < 500ms (p95) |
| Predictor latency | < 50ms |
| Throughput | 500–2000 events/sec |
| Analytics queries | < 200ms for common calls |

---

## 📁 Repository Structure

```
/
├── services/
│   ├── ingestion/        # Event intake service
│   ├── state-consumer/   # Live state processor
│   ├── analytics/        # ClickHouse queries
│   ├── predictor/        # Win probability calculator
│   └── api-gateway/      # REST + GraphQL + WS
├── packages/
│   └── shared/           # Shared types, utils, contracts
├── infra/
│   ├── clickhouse/       # ClickHouse schema
│   ├── postgres/         # Postgres migrations
│   ├── redis/            # Redis config
│   ├── grafana/          # Dashboards
│   └── prometheus/       # Prometheus config
├── docker-compose.yml
├── package.json
└── README.md
```

---

## 🗺 Roadmap

- [ ] Replace rule-based predictor with ML model (versioned)
- [ ] Add backfill/replay pipeline + correctness checks
- [ ] Multi-tenant API keys + quotas
- [ ] k6 load tests + capacity report
- [ ] Kubernetes manifests
- [ ] OpenAPI + GraphQL schema export

---

## 🏛 API Stability & Versioning

### Versioning
The B2B API is versioned via the URI path: `/api/v1`.
Breaking changes will result in a new major version (e.g., `/api/v2`).
Check `docs/API.md` for detailed endpoint policies.

### Stability Guarantees
- **v1**: Stable. Supported for at least 12 months after deprecated.
- **Experimental**: Headers `X-Esports-Beta` may enable unstable features.

---

## 📝 License

MIT

---

## 🤝 Contributing

This is a demo/portfolio project. Feel free to fork and adapt for your own use cases.
