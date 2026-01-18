/**
 * Production Metrics
 * 
 * Centralized metrics definitions for all services.
 * Includes SLO-critical metrics for monitoring.
 */

import { MetricsRegistry } from './metrics';

/**
 * Create production metrics registry with all SLO metrics
 */
export function createProductionMetrics(serviceName: string) {
    const registry = new MetricsRegistry();
    const prefix = serviceName.replace(/-/g, '_');

    return {
        registry,

        // ============================================
        // E2E Latency Metrics (SLO Critical)
        // ============================================

        /** End-to-end latency: event received → prediction published */
        e2eLatency: registry.createHistogram(
            'e2e_latency_ms',
            'End-to-end latency from event ingestion to prediction publish (ms)',
            ['event_type'],
            [50, 100, 200, 300, 400, 500, 750, 1000, 2000]
        ),

        /** Queue lag: ts_ingest → consumer processing start */
        queueLag: registry.createHistogram(
            'queue_lag_ms',
            'Time spent in queue before processing (ms)',
            [],
            [10, 25, 50, 100, 250, 500, 1000]
        ),

        /** Predictor latency: prediction calculation time */
        predictorLatency: registry.createHistogram(
            'predictor_latency_ms',
            'Prediction calculation latency (ms)',
            ['model_version'],
            [5, 10, 25, 50, 100, 250]
        ),

        /** WebSocket fanout latency: publish → all subscribers notified */
        wsFanoutLatency: registry.createHistogram(
            'ws_fanout_latency_ms',
            'WebSocket fanout latency to all subscribers (ms)',
            ['channel'],
            [1, 5, 10, 25, 50, 100]
        ),

        // ============================================
        // Stage Latency Metrics
        // ============================================

        /** Per-stage latency breakdown */
        stageLatency: registry.createHistogram(
            'stage_latency_ms',
            'Latency per processing stage (ms)',
            ['stage'],
            [5, 10, 25, 50, 100, 250, 500]
        ),

        // ============================================
        // SLO Tracking Metrics
        // ============================================

        /** SLO violations counter */
        sloViolations: registry.createCounter(
            'e2e_latency_slo_violations_total',
            'Count of requests exceeding 500ms SLO',
            ['event_type']
        ),

        /** Total requests for SLO calculation */
        e2eRequests: registry.createCounter(
            'e2e_requests_total',
            'Total requests processed for e2e latency tracking',
            ['event_type']
        ),

        // ============================================
        // Service-specific Metrics
        // ============================================

        /** Requests counter */
        requests: registry.createCounter(
            `${prefix}_requests_total`,
            'Total requests',
            ['method', 'path', 'status']
        ),

        /** Errors counter */
        errors: registry.createCounter(
            `${prefix}_errors_total`,
            'Total errors',
            ['type']
        ),

        /** Request latency */
        requestLatency: registry.createHistogram(
            `${prefix}_request_latency_ms`,
            'Request latency (ms)',
            ['method', 'path'],
            [5, 10, 25, 50, 100, 250, 500]
        ),

        // ============================================
        // Queue/Stream Metrics
        // ============================================

        /** Stream pending messages */
        streamPending: registry.createGauge(
            'stream_pending_messages',
            'Number of pending (unacked) messages in stream',
            ['stream']
        ),

        /** Events processed */
        eventsProcessed: registry.createCounter(
            `${prefix}_events_processed_total`,
            'Total events processed',
            ['type']
        ),

        /** Events failed */
        eventsFailed: registry.createCounter(
            `${prefix}_events_failed_total`,
            'Total events failed',
            ['type']
        ),

        // ============================================
        // ClickHouse Metrics
        // ============================================

        /** ClickHouse insert latency */
        clickhouseInsertLatency: registry.createHistogram(
            'clickhouse_insert_latency_ms',
            'ClickHouse batch insert latency (ms)',
            [],
            [50, 100, 250, 500, 1000, 2500]
        ),

        /** ClickHouse rows inserted */
        clickhouseRowsInserted: registry.createCounter(
            'clickhouse_events_inserted_total',
            'Total events inserted into ClickHouse',
            ['table']
        ),

        // ============================================
        // Helper Methods
        // ============================================

        /** Record e2e latency and track SLO */
        recordE2ELatency(latencyMs: number, eventType: string) {
            this.e2eLatency.observe(latencyMs, { event_type: eventType });
            this.e2eRequests.inc({ event_type: eventType });

            if (latencyMs > 500) {
                this.sloViolations.inc({ event_type: eventType });
            }
        },

        /** Record stage timing */
        recordStage(stage: string, latencyMs: number) {
            this.stageLatency.observe(latencyMs, { stage });
        },
    };
}

export type ProductionMetrics = ReturnType<typeof createProductionMetrics>;
