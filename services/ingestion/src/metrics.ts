/**
 * Ingestion Service Metrics
 */

import { MetricsRegistry } from '@esports/shared';

export const registry = new MetricsRegistry();

// Counters
export const eventsReceived = registry.createCounter(
    'ingestion_events_received_total',
    'Total number of events received',
    ['type', 'source']
);

export const eventsProcessed = registry.createCounter(
    'ingestion_events_processed_total',
    'Total number of events successfully processed',
    ['type']
);

export const eventsDuplicate = registry.createCounter(
    'ingestion_events_duplicate_total',
    'Total number of duplicate events rejected',
    []
);

export const eventsInvalid = registry.createCounter(
    'ingestion_events_invalid_total',
    'Total number of invalid events rejected',
    ['reason']
);

export const errorsTotal = registry.createCounter(
    'ingestion_errors_total',
    'Total number of errors',
    ['type']
);

// Histograms
export const processingLatency = registry.createHistogram(
    'ingestion_processing_latency_ms',
    'Event processing latency in milliseconds',
    ['type'],
    [1, 5, 10, 25, 50, 100, 250, 500]
);

export const batchSize = registry.createHistogram(
    'ingestion_batch_size',
    'Size of event batches',
    [],
    [1, 5, 10, 25, 50, 100]
);

// Gauges
export const queueDepth = registry.createGauge(
    'ingestion_queue_depth',
    'Current queue depth',
    ['queue']
);
