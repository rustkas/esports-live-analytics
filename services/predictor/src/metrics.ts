/**
 * Predictor Service Metrics
 */

import { MetricsRegistry } from '@esports/shared';

export const registry = new MetricsRegistry();

export const predictionsTotal = registry.createCounter(
    'predictor_predictions_total',
    'Total predictions calculated',
    ['trigger_type']
);

export const predictionLatency = registry.createHistogram(
    'predictor_prediction_latency_ms',
    'Prediction calculation latency in milliseconds',
    [],
    [1, 2, 5, 10, 25, 50, 100]
);

export const requestsTotal = registry.createCounter(
    'predictor_requests_total',
    'Total HTTP requests',
    ['method', 'path', 'status']
);

export const errorsTotal = registry.createCounter(
    'predictor_errors_total',
    'Total errors',
    ['type']
);
