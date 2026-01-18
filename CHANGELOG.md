# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Replay & Audit system for match debugging
- Broadcaster service for WebSocket fanout
- Protobuf schema for gRPC ingestion (optional)
- Clock skew validation in Ingestion
- HMAC signature verification for providers
- Admin RBAC with API key authentication
- Prometheus alert rules for SLOs
- Kubernetes manifests and Helm chart skeleton
- CI/CD pipeline with integration tests
- Nightly load testing workflow
- Operational runbooks
- Error budget policy

### Changed
- Externalized secrets in docker-compose
- Upgraded ClickHouse writer with Circuit Breaker and Disk Spool
- Improved PostgreSQL connection pool configuration

### Fixed
- Duplicate PORT configuration in docker-compose

## [1.0.0] - 2026-01-15

### Added
- Initial release with full pipeline
- Ingestion, State Consumer, Analytics, Predictor, API Gateway
- Real-time WebSocket subscriptions
- GraphQL and REST APIs
- B2B partner authentication
- Rate limiting and quotas
