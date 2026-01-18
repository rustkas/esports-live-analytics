# Service Level Agreement (SLA)

## Availability
We guarantee **99.9% availability** for the `api-gateway` and `predictor` services.

## Performance
- **Prediction Latency**: < 50ms (p95)
- **API Response Time**: < 100ms (p95) for cached resources, < 200ms for dynamic.
- **Webhook Delivery**: < 1000ms from event generation (excluding Partner latency).

## Support
- **Critical Issues**: Response within 15 minutes (24/7).
- **Non-Critical**: Response within 24 hours.

## Webhook Policy
- **Retries**: 3 attempts with exponential backoff (1s, 2s, 4s).
- **Dead Letter Queue (DLQ)**: Failed events stored for 7 days.
- **Signature**: HMAC-SHA256 (`X-Esports-Signature`).

## Rate Limits
- Standard Tier: 1000 req/min
- Premium Tier: 10,000 req/min
- Custom: Contact Sales
