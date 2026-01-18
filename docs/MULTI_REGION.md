# Multi-Region Architecture Plan

## Overview
This document outlines the strategy for deploying the eSports Analytics Platform across multiple geographic regions for improved latency, availability, and compliance.

---

## Phase 1: Primary + DR (Active-Passive)

### Regions
- **Primary:** EU-West (Frankfurt)
- **DR:** EU-North (Stockholm)

### Data Replication

#### PostgreSQL
- **Strategy:** Streaming replication with pg_basebackup
- **RPO:** < 1 minute
- **RTO:** 15 minutes (manual failover)
- **Tool:** Patroni + etcd for HA

#### ClickHouse
- **Strategy:** ReplicatedMergeTree with ZooKeeper
- **RPO:** Near-realtime (async replication)
- **RTO:** 5 minutes (automatic via CH cluster)
- **Sharding:** By `match_id` hash

#### Redis
- **Strategy:** Redis Sentinel (failover) or Redis Cluster
- **RPO:** 0 (sync replication optional)
- **Note:** State is ephemeral; rebuild from CH on failover acceptable

### Traffic Routing
- **DNS:** Route53 health-checked failover
- **CDN:** CloudFront for static assets and API caching

---

## Phase 2: Multi-Region Active-Active

### Regions
- EU-West (Frankfurt) - Primary for EU customers
- US-East (Virginia) - Primary for NA customers
- APAC (Singapore) - Primary for Asian customers

### Data Strategy

#### Write Path
- Ingestion is region-local
- Cross-region replication via Kafka Connect or custom sync

#### Read Path
- Read from local region first
- Fallback to primary on miss

### Consistency Model
- **Eventual Consistency:** 5-30 second lag acceptable for analytics
- **Strong Read:** Route to primary for real-time predictions

---

## Cost Considerations

| Component | EU-West | US-East | APAC | Monthly Est. |
|-----------|---------|---------|------|--------------|
| Compute (K8s) | $2,000 | $1,500 | $1,200 | $4,700 |
| ClickHouse | $1,500 | $800 | $600 | $2,900 |
| PostgreSQL | $400 | $300 | $250 | $950 |
| Cross-region egress | - | $500 | $400 | $900 |
| **Total** | | | | **$9,450** |

---

## Timeline
- **Q1:** Phase 1 DR setup
- **Q2:** Monitoring & failover testing
- **Q3:** Phase 2 US-East
- **Q4:** Phase 2 APAC
