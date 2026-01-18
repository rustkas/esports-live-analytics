# Client Tiering System

## Overview
The platform supports differentiated service levels for B2B partners based on their subscription tier.

---

## Tier Definitions

### 🥈 Silver Tier
**Target:** Small betting sites, analytics hobbyists

| Feature | Limit |
|---------|-------|
| API Rate Limit | 100 req/min |
| WebSocket Connections | 10 |
| Event Quota | 10M/month |
| Data Retention | 7 days |
| Support | Email (48h SLA) |
| Webhooks | ❌ |
| Custom Models | ❌ |
| SLA | 99.5% |

### 🥇 Gold Tier
**Target:** Mid-size betting platforms, esports media

| Feature | Limit |
|---------|-------|
| API Rate Limit | 1,000 req/min |
| WebSocket Connections | 100 |
| Event Quota | 100M/month |
| Data Retention | 30 days |
| Support | Email (24h SLA) + Slack |
| Webhooks | ✅ |
| Custom Models | ❌ |
| SLA | 99.9% |
| Priority Routing | ✅ |

### 💎 Platinum Tier
**Target:** Enterprise betting operators, major esports leagues

| Feature | Limit |
|---------|-------|
| API Rate Limit | Unlimited |
| WebSocket Connections | Unlimited |
| Event Quota | Unlimited |
| Data Retention | 1 year |
| Support | Dedicated CSM + 24/7 hotline |
| Webhooks | ✅ Priority delivery |
| Custom Models | ✅ |
| SLA | 99.99% |
| Private Infrastructure | Optional |

---

## Implementation

### Database Schema (`api_clients` table)
```sql
ALTER TABLE api_clients ADD COLUMN tier VARCHAR(20) DEFAULT 'silver';
-- Values: 'silver', 'gold', 'platinum'
```

### Rate Limit Configuration
```typescript
const TIER_LIMITS = {
  silver: { rpm: 100, connections: 10 },
  gold: { rpm: 1000, connections: 100 },
  platinum: { rpm: Infinity, connections: Infinity },
};
```

### Priority Routing
Gold and Platinum clients are routed to dedicated API Gateway instances with higher resource allocation.

---

## Upgrade Path
1. Self-service upgrade via billing portal
2. Automatic provisioning of increased limits
3. Webhook enablement requires endpoint verification
