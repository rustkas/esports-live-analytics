# Operations Runbooks

## 1. Incident: Queue Stuck (High Consumer Lag)

**Severity:** Critical
**Symptoms:** `consumer_lag` > 5000, `HighLatency` alerts firing.

### Diagnosis
1. Check Redis Memory: `redis-cli info memory`. If maxed out, eviction policy might be dropping keys.
2. Check Consumer Logs: `docker logs esports-state-consumer`. Look for "CrashLoopBackOff" or "Unhandled Exception".
3. Check DLQ: Is the DLQ filling up rapidly? `POST /admin/dlq/stats`.

### Resolution
- **Restart Consumer:** `docker-compose restart state-consumer`.
- **Scale Up:** If CPU capped, increase replicas (requires partitioning/sharding to be configured).
- **Drain DLQ:** If valid events are stuck, replay them: `POST /admin/dlq/requeue/all`.
- **Flush Buffer:** If Redis is full, temporarily stop ingestion or increase Redis RAM.

---

## 2. Incident: ClickHouse Slow Inserts

**Severity:** Warning -> Critical
**Symptoms:** `ch_write_duration` > 1s, `async_insert` backlog growing.

### Diagnosis
1. Check Active Merges: `SELECT * FROM system.merges`. Too many merges = disk pressure.
2. Check Disk IO: `iostat -x`.
3. Check Part Count: `SELECT table, partition, count(*) FROM system.parts GROUP BY table, partition`. High part count (>50 per partition) means merges aren't keeping up.

### Resolution
- **Throttling:** Enable "Spool Mode" manually if needed (Circuit Breaker does this auto).
- **Optimize:** access CH console, run `OPTIMIZE TABLE cs2_events_parsed FINAL` (Careful: expensive).
- **Hardware:** Scale up CH volume IOPS.

---

## 3. Incident: Prediction Drift

**Severity:** Warning
**Symptoms:** Accuracy dropping below baseline (e.g. < 60% accuracy on closed matches).

### Diagnosis
1. Run "Accuracy Report": Compare `p_team_a_win` vs actual `winner` for last 24h matches.
2. Check Input Distribution: Are feature values (gold, K/D) shifting? Feature drift.

### Resolution
- **Retrain:** Trigger model retraining on recent dataset.
- **Rollback:** Revert to previous `model_version` via `predictor` config / env vars.
- **Audit:** Check `cs2_predictions` table for specific matches where confidence was high but wrong.

---

## 4. Incident: Provider Schema Change

**Severity:** Critical (Ingestion Failure)
**Symptoms:** `validation_errors` spiking, `Invalid event format`.

### Diagnosis
1. Check Ingestion Logs: Look for Zod validation errors.
2. Compare Payload: Capture sample failing event (via debug logs or DLQ).

### Resolution
1. **Update Schema:** Modify `NormalizedEventSchema` in `@esports/shared`.
2. **Deploy Hotfix:** Rebuild and deploy `ingestion` service.
3. **Replay DLQ:** Once schema is fixed, replay the rejected events from DLQ: `POST /admin/dlq/requeue/all`.
