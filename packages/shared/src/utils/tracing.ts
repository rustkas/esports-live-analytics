/**
 * Tracing Context
 * 
 * Provides distributed tracing for e2e latency measurement.
 * Propagates trace context through all stages of event processing.
 */

export interface TraceContext {
    trace_id: string;
    span_id: string;
    parent_span_id?: string;
    ts_start: number;  // performance.now() at trace start
    stages: TraceStage[];
}

export interface TraceStage {
    name: string;
    ts_start: number;
    ts_end?: number;
    duration_ms?: number;
    metadata?: Record<string, unknown>;
}

/**
 * Create a new trace context
 */
export function createTrace(traceId?: string): TraceContext {
    return {
        trace_id: traceId ?? crypto.randomUUID(),
        span_id: crypto.randomUUID().slice(0, 8),
        ts_start: performance.now(),
        stages: [],
    };
}

/**
 * Start a new stage in the trace
 */
export function startStage(trace: TraceContext, name: string, metadata?: Record<string, unknown>): TraceStage {
    const stage: TraceStage = {
        name,
        ts_start: performance.now(),
        metadata,
    };
    trace.stages.push(stage);
    return stage;
}

/**
 * End a stage
 */
export function endStage(stage: TraceStage): void {
    stage.ts_end = performance.now();
    stage.duration_ms = stage.ts_end - stage.ts_start;
}

/**
 * Calculate total e2e latency
 */
export function getE2ELatency(trace: TraceContext): number {
    return performance.now() - trace.ts_start;
}

/**
 * Serialize trace for logging/propagation
 */
export function serializeTrace(trace: TraceContext): string {
    return JSON.stringify({
        trace_id: trace.trace_id,
        span_id: trace.span_id,
        parent_span_id: trace.parent_span_id,
        stages: trace.stages.map(s => ({
            name: s.name,
            duration_ms: s.duration_ms,
            ...s.metadata,
        })),
        e2e_latency_ms: getE2ELatency(trace),
    });
}

/**
 * Parse trace from header/message
 */
export function parseTrace(data: string): TraceContext | null {
    try {
        const parsed = JSON.parse(data);
        return {
            trace_id: parsed.trace_id,
            span_id: parsed.span_id,
            parent_span_id: parsed.parent_span_id,
            ts_start: performance.now(), // Reset for local timing
            stages: [],
        };
    } catch {
        return null;
    }
}

/**
 * Create child span
 */
export function createChildSpan(parent: TraceContext): TraceContext {
    return {
        trace_id: parent.trace_id,
        span_id: crypto.randomUUID().slice(0, 8),
        parent_span_id: parent.span_id,
        ts_start: performance.now(),
        stages: [],
    };
}

/**
 * Trace header names
 */
export const TRACE_HEADERS = {
    TRACE_ID: 'X-Trace-Id',
    SPAN_ID: 'X-Span-Id',
    PARENT_SPAN: 'X-Parent-Span-Id',
} as const;
