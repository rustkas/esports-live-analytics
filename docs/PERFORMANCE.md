# Performance Tuning & Benchmarking

## Running Load Tests
We use [k6](https://k6.io/) to simulate high-throughput ingestion scenarios.

### 1. 500 events/s (Baseline)
```bash
API_URL=http://localhost:8081 k6 run scripts/k6-load-test.js --vus 50
```

### 2. 2000 events/s (Peak)
```bash
API_URL=http://localhost:8081 k6 run scripts/k6-load-test.js --vus 200
```

## Optimization Settings

### Ingestion Service
- **Keep-Alive**: Enabled by default (Hono/Bun).
- **JSON Parsing**: Native (fast).
- **Body Limit**: 64KB enforced via `content-length` check (Fast Fail).
- **Trace ID**: Generated optimally if missing.

### State Consumer (BullMQ)
- **Concurrency**: 1 per shard (via `concurrency: 1` in worker options).
- **Redis Persistence**: AOF enabled (`appendonly yes` in `redis.conf`) for durability.
- **Deduplication**: Sliding window in Redis (1h TTL).

### ClickHouse Writer
- **Async Insert**: Enabled (`async_insert=1`) to leverage efficient server-side batching.
- **Client Buffer**: Adaptive batching (up to 5k events) to reduce HTTP overhead.
- **Circuit Breaker**: Pauses writes if ClickHouse is unresponsive; buffers events (up to 50k) then drops oldest to prevent memory leaks.
- **Backpressure**: Implemented via BullMQ queue limits and worker rate limiting.
