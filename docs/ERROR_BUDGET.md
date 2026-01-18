# Error Budget Policy

## SLO Definitions

| Service | SLO Type | Target | Measurement |
|---------|----------|--------|-------------|
| **Ingestion** | Availability | 99.9% | Status != 5xx |
| **Ingestion** | Latency | 99% < 200ms | `http_request_duration_seconds` |
| **API Gateway** | Availability | 99.9% | Status != 5xx |
| **E2E Pipeline** | Latency | 95% < 500ms | `e2e_latency` (Ingest -> Broadcast) |

## Budget Calculation (Monthly)

**Window:** Rolling 28 days.

**Total Requests Example:** 10,000,000 requests.
**Allowed Errors (0.1%):** 10,000 errors.

## Policy Triggers

### 1. Burn Rate Alerting
- **Fast Burn (1h):** If burning > 2% of budget in 1 hour -> **Page On-Call**.
- **Slow Burn (24h):** If burning > 5% of budget in 24 hours -> **Ticket to Engineering**.

### 2. Budget Exhaustion Actions
If Error Budget < 0 (consumed):

1. **Feature Freeze:** No new features deployed until budget recovers.
2. **Reliability Sprint:** All engineering effort shifts to:
   - Fixing bugs.
   - Improving tests.
   - Optimizing performance.
3. **Exceptions:** Critical security patches or business-critical hotfixes require VP approval.

## Reset Policy
Budget resets on the 1st of every month OR resets manually if "Reliability Sprint" successfully resolves the root cause.
