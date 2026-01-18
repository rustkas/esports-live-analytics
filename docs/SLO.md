# Service Level Objectives (SLO)

## Overview

This document defines the Service Level Objectives for the CS2 Live Analytics Platform.
These SLOs are designed for a B2B betting data provider use case where latency and reliability are critical.

---

## SLO Summary

| Metric | Target | Measurement Window | Priority |
|--------|--------|-------------------|----------|
| **E2E Latency p95** | < 500ms | Rolling 5 min | P0 |
| **E2E Latency p99** | < 1000ms | Rolling 5 min | P1 |
| **Error Rate** | < 0.1% | Rolling 5 min | P0 |
| **Availability** | > 99.9% | Monthly | P0 |
| **Data Loss** | 0% | Per match | P0 |

---

## Detailed SLO Definitions

### SLO-1: End-to-End Latency

**Objective**: Events must be processed and predictions published within 500ms (p95).

**Definition**:
- **Start time**: `ts_ingest` — when event is received by ingestion service
- **End time**: When prediction is published to Redis Pub/Sub

**Measurement**:
```promql
# P95 E2E Latency
histogram_quantile(0.95, 
  sum(rate(e2e_latency_ms_bucket[5m])) by (le)
)

# SLO Compliance (% of requests meeting SLO)
(
  sum(rate(e2e_latency_ms_bucket{le="500"}[5m]))
  /
  sum(rate(e2e_latency_ms_count[5m]))
) * 100
```

**Thresholds**:
| Level | p95 Latency | Action |
|-------|-------------|--------|
| ✅ Healthy | < 300ms | None |
| ⚠️ Warning | 300-500ms | Monitor |
| 🔴 Critical | > 500ms | Alert + Page |

---

### SLO-2: Error Rate

**Objective**: Less than 0.1% of events should fail processing.

**Definition**:
- **Error**: Any event that fails validation, queueing, or processing
- **Excludes**: Duplicate events (idempotency is working correctly)

**Measurement**:
```promql
# Error Rate (%)
(
  sum(rate(ingestion_errors_total[5m])) +
  sum(rate(state_consumer_events_failed_total[5m]))
)
/
sum(rate(ingestion_events_received_total[5m]))
* 100
```

**Thresholds**:
| Level | Error Rate | Action |
|-------|------------|--------|
| ✅ Healthy | < 0.05% | None |
| ⚠️ Warning | 0.05-0.1% | Monitor |
| 🔴 Critical | > 0.1% | Alert |

---

### SLO-3: Availability

**Objective**: Platform must be available 99.9% of the time (monthly).

**Definition**:
- **Available**: All health checks passing
- **Downtime**: Any period where health checks fail

**Measurement**:
```promql
# Availability (%)
(
  sum(up{job=~"ingestion|state-consumer|analytics|predictor|api-gateway"})
  /
  count(up{job=~"ingestion|state-consumer|analytics|predictor|api-gateway"})
) * 100
```

**Error Budget** (per month):
- 99.9% uptime = 43.2 minutes downtime allowed
- 99.95% uptime = 21.6 minutes downtime allowed
- 99.99% uptime = 4.3 minutes downtime allowed

---

### SLO-4: Data Integrity

**Objective**: Zero event loss for completed matches.

**Definition**:
- All events sent to ingestion should be queryable in ClickHouse
- Verified by checksum comparison between source and storage

**Measurement**:
```promql
# Events received vs stored (should equal 1.0)
sum(rate(clickhouse_events_inserted_total[1h]))
/
sum(rate(ingestion_events_processed_total[1h]))
```

---

## Latency Budget Breakdown

Target: **500ms E2E p95**

| Stage | Budget (p95) | Notes |
|-------|--------------|-------|
| Ingestion | 20ms | Validation + Redis publish |
| Stream Queue | 50ms | Redis XREADGROUP blocking |
| State Update | 30ms | Redis HSET/HMSET |
| ClickHouse Write | 100ms | Async, batched |
| Prediction | 50ms | Model inference |
| Pub/Sub | 10ms | Redis PUBLISH |
| **Buffer** | **240ms** | For spikes |
| **Total** | **500ms** | |

---

## Alerting Rules

### Critical Alerts (Page immediately)

1. **E2E Latency SLO Breach**
   - Condition: p95 > 500ms for 2 minutes
   - Action: Page on-call

2. **Error Rate SLO Breach**
   - Condition: Error rate > 0.1% for 2 minutes
   - Action: Page on-call

3. **Service Down**
   - Condition: Any service health check failing for 1 minute
   - Action: Page on-call

### Warning Alerts (Notify)

1. **Latency Degradation**
   - Condition: p95 > 300ms for 5 minutes
   - Action: Slack notification

2. **Error Rate Elevated**
   - Condition: Error rate > 0.05% for 5 minutes
   - Action: Slack notification

3. **Queue Backlog**
   - Condition: Stream pending > 1000 for 2 minutes
   - Action: Slack notification

---

## SLO Dashboard Requirements

The SLO dashboard should display:

1. **SLO Compliance Panel** (prominent)
   - Current compliance % for each SLO
   - Color-coded status

2. **Error Budget Burn Rate**
   - How fast we're consuming the monthly error budget
   - Projected budget exhaustion date

3. **Latency Percentiles**
   - Real-time p50, p95, p99 charts
   - Comparison to SLO threshold line

4. **Stage Breakdown**
   - Latency contribution per processing stage
   - Identify bottlenecks

5. **Trends**
   - 24-hour, 7-day, 30-day trends
   - Regression detection

---

## Incident Response

### SLO Breach Response

| Severity | Response Time | Escalation |
|----------|---------------|------------|
| P0 (Critical) | 5 minutes | Immediate page |
| P1 (High) | 15 minutes | Page after warning |
| P2 (Medium) | 1 hour | Business hours only |

### Post-Incident

1. Create incident report
2. Update SLO if unrealistic
3. Implement fixes
4. Add monitoring for root cause

---

## Review Cadence

- **Weekly**: Review SLO compliance
- **Monthly**: Review error budget consumption
- **Quarterly**: Re-evaluate SLO targets
