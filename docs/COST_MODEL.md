# Cost Model & Infrastructure Economics

## Overview
This document outlines the cost structure for running the eSports Analytics Platform at various scales.

---

## Baseline (1,000 events/sec, 10 concurrent matches)

### Compute
| Service | Instances | vCPU | RAM | Monthly Cost |
|---------|-----------|------|-----|--------------|
| Ingestion | 2 | 0.5 | 512MB | $40 |
| State Consumer | 1 | 1.0 | 1GB | $50 |
| API Gateway | 2 | 0.5 | 512MB | $40 |
| Analytics | 1 | 0.5 | 512MB | $25 |
| Predictor | 1 | 0.5 | 512MB | $25 |
| Broadcaster | 2 | 0.5 | 256MB | $30 |
| **Subtotal** | | | | **$210** |

### Storage
| Service | Type | Size | Monthly Cost |
|---------|------|------|--------------|
| PostgreSQL | SSD | 50GB | $10 |
| ClickHouse | SSD | 500GB | $100 |
| Redis | RAM | 1GB | $15 |
| **Subtotal** | | | **$125** |

### Traffic (Egress)
| Type | Volume | Cost/GB | Monthly Cost |
|------|--------|---------|--------------|
| API Responses | 500GB | $0.09 | $45 |
| WebSocket | 200GB | $0.09 | $18 |
| Cross-AZ | 100GB | $0.01 | $1 |
| **Subtotal** | | | **$64** |

### **Total Baseline: ~$400/month**

---

## Scale (10,000 events/sec, 100 concurrent matches)

| Category | Cost |
|----------|------|
| Compute | $1,500 |
| Storage | $800 |
| Egress | $400 |
| Monitoring | $200 |
| **Total** | **$2,900/month** |

---

## Unit Economics

| Metric | Value |
|--------|-------|
| Cost per 1M events ingested | $0.12 |
| Cost per 1M API requests | $0.08 |
| Cost per concurrent match | $4/month |
| Cost per GB stored (30-day retention) | $0.20 |

---

## Revenue Model (B2B SaaS)

### Tier Pricing
| Tier | Events/month | API Calls/month | Price |
|------|--------------|-----------------|-------|
| **Silver** | 10M | 1M | $500/month |
| **Gold** | 100M | 10M | $2,500/month |
| **Platinum** | Unlimited | Unlimited | Custom |

### Margin Analysis
| Tier | Revenue | Est. Cost | Margin |
|------|---------|-----------|--------|
| Silver | $500 | $50 | 90% |
| Gold | $2,500 | $300 | 88% |

---

## Cost Optimization Strategies

1. **Reserved Instances:** 30-40% savings on compute
2. **Spot/Preemptible:** 60-70% savings for non-critical workloads
3. **ClickHouse Compression:** 10:1 ratio reduces storage costs
4. **TTL Policies:** Auto-expire old data to manage storage
5. **Caching:** Redis reduces CH query load by 80%
