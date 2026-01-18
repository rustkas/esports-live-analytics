/**
 * Event Context
 * 
 * Carries trace_id, match context, and timing through the processing pipeline.
 * All services use this for structured logging and tracing.
 */

export interface EventContext {
    /** Unique trace ID for this event's journey through the system */
    trace_id: string;

    /** Match identifier */
    match_id: string;

    /** Map identifier */
    map_id: string;

    /** Event type */
    event_type: string;

    /** Original event ID */
    event_id: string;

    /** When event was received by ingestion */
    ts_ingest: number;

    /** When processing started */
    ts_process_start?: number;

    /** When prediction was published */
    ts_predict_published?: number;

    /** Additional context fields */
    [key: string]: unknown;
}

/**
 * Create event context from a base event
 */
export function createEventContext(event: {
    event_id: string;
    match_id: string;
    map_id: string;
    type: string;
    ts_ingest?: string;
    trace_id?: string;
}): EventContext {
    return {
        trace_id: event.trace_id ?? crypto.randomUUID(),
        match_id: event.match_id,
        map_id: event.map_id,
        event_type: event.type,
        event_id: event.event_id,
        ts_ingest: event.ts_ingest ? new Date(event.ts_ingest).getTime() : Date.now(),
    };
}

/**
 * Add trace_id to event if not present
 */
export function ensureTraceId<T extends { trace_id?: string }>(event: T): T & { trace_id: string } {
    return {
        ...event,
        trace_id: event.trace_id ?? crypto.randomUUID(),
    };
}

/**
 * Calculate queue lag from context
 */
export function calculateQueueLag(ctx: EventContext): number {
    if (!ctx.ts_process_start) return 0;
    return ctx.ts_process_start - ctx.ts_ingest;
}

/**
 * Calculate e2e latency from context
 */
export function calculateE2ELatency(ctx: EventContext): number {
    if (!ctx.ts_predict_published) return 0;
    return ctx.ts_predict_published - ctx.ts_ingest;
}

/**
 * Context fields for structured logging
 */
export function getLogContext(ctx: EventContext): Record<string, unknown> {
    return {
        trace_id: ctx.trace_id,
        match_id: ctx.match_id,
        map_id: ctx.map_id,
        event_type: ctx.event_type,
        event_id: ctx.event_id,
    };
}
