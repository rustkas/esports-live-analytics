/**
 * Prometheus Metrics Helpers
 * Simple utilities for creating and exposing Prometheus metrics
 */

// ============================================
// Metric Types
// ============================================

interface CounterMetric {
    type: 'counter';
    name: string;
    help: string;
    labels: string[];
    values: Map<string, number>;
}

interface GaugeMetric {
    type: 'gauge';
    name: string;
    help: string;
    labels: string[];
    values: Map<string, number>;
}

interface HistogramMetric {
    type: 'histogram';
    name: string;
    help: string;
    labels: string[];
    buckets: number[];
    observations: Map<string, { count: number; sum: number; buckets: number[] }>;
}

type Metric = CounterMetric | GaugeMetric | HistogramMetric;

// ============================================
// Registry
// ============================================

export class MetricsRegistry {
    private metrics: Map<string, Metric> = new Map();

    // Counter
    createCounter(name: string, help: string, labels: string[] = []): Counter {
        const metric: CounterMetric = {
            type: 'counter',
            name,
            help,
            labels,
            values: new Map(),
        };
        this.metrics.set(name, metric);
        return new Counter(metric);
    }

    // Gauge
    createGauge(name: string, help: string, labels: string[] = []): Gauge {
        const metric: GaugeMetric = {
            type: 'gauge',
            name,
            help,
            labels,
            values: new Map(),
        };
        this.metrics.set(name, metric);
        return new Gauge(metric);
    }

    // Histogram
    createHistogram(
        name: string,
        help: string,
        labels: string[] = [],
        buckets: number[] = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]
    ): Histogram {
        const metric: HistogramMetric = {
            type: 'histogram',
            name,
            help,
            labels,
            buckets,
            observations: new Map(),
        };
        this.metrics.set(name, metric);
        return new Histogram(metric);
    }

    // Output Prometheus format
    metrics(): string {
        const lines: string[] = [];

        for (const metric of this.metrics.values()) {
            lines.push(`# HELP ${metric.name} ${metric.help}`);

            if (metric.type === 'counter') {
                lines.push(`# TYPE ${metric.name} counter`);
                for (const [labelStr, value] of metric.values) {
                    const labels = labelStr ? `{${labelStr}}` : '';
                    lines.push(`${metric.name}${labels} ${value}`);
                }
            } else if (metric.type === 'gauge') {
                lines.push(`# TYPE ${metric.name} gauge`);
                for (const [labelStr, value] of metric.values) {
                    const labels = labelStr ? `{${labelStr}}` : '';
                    lines.push(`${metric.name}${labels} ${value}`);
                }
            } else if (metric.type === 'histogram') {
                lines.push(`# TYPE ${metric.name} histogram`);
                for (const [labelStr, obs] of metric.observations) {
                    const labelPrefix = labelStr ? `${labelStr},` : '';
                    for (let i = 0; i < metric.buckets.length; i++) {
                        const le = metric.buckets[i]!;
                        const count = obs.buckets.slice(0, i + 1).reduce((a, b) => a + b, 0);
                        lines.push(`${metric.name}_bucket{${labelPrefix}le="${le}"} ${count}`);
                    }
                    lines.push(`${metric.name}_bucket{${labelPrefix}le="+Inf"} ${obs.count}`);
                    lines.push(`${metric.name}_sum{${labelStr ? labelStr : ''}} ${obs.sum}`);
                    lines.push(`${metric.name}_count{${labelStr ? labelStr : ''}} ${obs.count}`);
                }
            }

            lines.push('');
        }

        return lines.join('\n');
    }

    // Reset all metrics (for testing)
    reset(): void {
        for (const metric of this.metrics.values()) {
            if (metric.type === 'counter' || metric.type === 'gauge') {
                metric.values.clear();
            } else if (metric.type === 'histogram') {
                metric.observations.clear();
            }
        }
    }
}

// ============================================
// Metric Classes
// ============================================

class Counter {
    constructor(private metric: CounterMetric) { }

    inc(labels: Record<string, string> = {}, value = 1): void {
        const key = this.labelsToString(labels);
        const current = this.metric.values.get(key) ?? 0;
        this.metric.values.set(key, current + value);
    }

    private labelsToString(labels: Record<string, string>): string {
        return Object.entries(labels)
            .map(([k, v]) => `${k}="${v}"`)
            .join(',');
    }
}

class Gauge {
    constructor(private metric: GaugeMetric) { }

    set(value: number, labels: Record<string, string> = {}): void {
        const key = this.labelsToString(labels);
        this.metric.values.set(key, value);
    }

    inc(labels: Record<string, string> = {}, value = 1): void {
        const key = this.labelsToString(labels);
        const current = this.metric.values.get(key) ?? 0;
        this.metric.values.set(key, current + value);
    }

    dec(labels: Record<string, string> = {}, value = 1): void {
        const key = this.labelsToString(labels);
        const current = this.metric.values.get(key) ?? 0;
        this.metric.values.set(key, current - value);
    }

    private labelsToString(labels: Record<string, string>): string {
        return Object.entries(labels)
            .map(([k, v]) => `${k}="${v}"`)
            .join(',');
    }
}

class Histogram {
    constructor(private metric: HistogramMetric) { }

    observe(value: number, labels: Record<string, string> = {}): void {
        const key = this.labelsToString(labels);

        let obs = this.metric.observations.get(key);
        if (!obs) {
            obs = { count: 0, sum: 0, buckets: new Array(this.metric.buckets.length).fill(0) };
            this.metric.observations.set(key, obs);
        }

        obs.count++;
        obs.sum += value;

        for (let i = 0; i < this.metric.buckets.length; i++) {
            if (value <= this.metric.buckets[i]!) {
                obs.buckets[i]!++;
            }
        }
    }

    // Timer helper
    startTimer(labels: Record<string, string> = {}): () => number {
        const start = performance.now();
        return () => {
            const duration = performance.now() - start;
            this.observe(duration, labels);
            return duration;
        };
    }

    private labelsToString(labels: Record<string, string>): string {
        return Object.entries(labels)
            .map(([k, v]) => `${k}="${v}"`)
            .join(',');
    }
}

// ============================================
// Global Registry
// ============================================

export const globalRegistry = new MetricsRegistry();

// ============================================
// Common Metrics Factory
// ============================================

export function createServiceMetrics(serviceName: string) {
    const prefix = serviceName.replace(/-/g, '_');

    return {
        requestsTotal: globalRegistry.createCounter(
            `${prefix}_requests_total`,
            'Total number of requests',
            ['method', 'path', 'status']
        ),
        requestLatency: globalRegistry.createHistogram(
            `${prefix}_request_latency_ms`,
            'Request latency in milliseconds',
            ['method', 'path']
        ),
        errorsTotal: globalRegistry.createCounter(
            `${prefix}_errors_total`,
            'Total number of errors',
            ['type']
        ),
    };
}
