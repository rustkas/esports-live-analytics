/**
 * Event Schema Validation
 * 
 * Zod schemas for event validation with:
 * - Schema versioning (event_schema_version)
 * - Strict required fields
 * - Ignored unknown fields (schema evolution)
 * - Payload size limits
 */

import { z } from 'zod';

// ============================================
// Schema Version
// ============================================

/** Current event schema version */
export const CURRENT_SCHEMA_VERSION = '1.0.0';

/** Supported schema versions for backwards compatibility */
export const SUPPORTED_SCHEMA_VERSIONS = ['1.0.0'] as const;

// ============================================
// Payload Size Limits
// ============================================

export const PAYLOAD_LIMITS = {
    /** Maximum single event payload size in bytes */
    MAX_EVENT_SIZE_BYTES: 64 * 1024, // 64KB

    /** Maximum batch size */
    MAX_BATCH_SIZE: 100,

    /** Maximum payload JSON string length */
    MAX_PAYLOAD_LENGTH: 32 * 1024, // 32KB for nested payload
} as const;

// ============================================
// Base Event Schema
// ============================================

export const BaseEventSchema = z.object({
    // Required fields (strictly validated)
    event_id: z.string().uuid('event_id must be a valid UUID'),
    match_id: z.string().uuid('match_id must be a valid UUID'),
    map_id: z.string().uuid('map_id must be a valid UUID'),
    round_no: z.number().int().min(0).max(50),
    ts_event: z.string().datetime({ message: 'ts_event must be ISO 8601 datetime' }),
    type: z.string().min(1).max(50),
    source: z.string().min(1).max(100),
    seq_no: z.number().int().min(0),
    payload: z.record(z.unknown()),

    // Optional fields
    ts_ingest: z.string().datetime().optional(),
    trace_id: z.string().uuid().optional(),

    // Schema version (defaults to current)
    event_schema_version: z.string().default(CURRENT_SCHEMA_VERSION),
}).passthrough(); // Allow unknown fields for schema evolution

export type BaseEventInput = z.input<typeof BaseEventSchema>;
export type BaseEventOutput = z.output<typeof BaseEventSchema>;

// ============================================
// Event Type Schemas
// ============================================

export const KillPayloadSchema = z.object({
    killer_player_id: z.string(),
    killer_team: z.enum(['A', 'B']),
    victim_player_id: z.string(),
    victim_team: z.enum(['A', 'B']),
    weapon: z.string(),
    is_headshot: z.boolean(),
    is_wallbang: z.boolean().optional(),
    is_through_smoke: z.boolean().optional(),
    is_no_scope: z.boolean().optional(),
    is_first_kill: z.boolean().optional(),
    attacker_blind: z.boolean().optional(),
}).passthrough();

export const RoundEndPayloadSchema = z.object({
    winner_team: z.enum(['A', 'B']),
    win_reason: z.enum(['elimination', 'bomb_exploded', 'bomb_defused', 'time_expired']),
    team_a_score: z.number().int().min(0),
    team_b_score: z.number().int().min(0),
    team_a_id: z.string(),
    team_b_id: z.string(),
}).passthrough();

export const RoundStartPayloadSchema = z.object({
    team_a_score: z.number().int().min(0),
    team_b_score: z.number().int().min(0),
    team_a_side: z.enum(['CT', 'T']),
    team_b_side: z.enum(['CT', 'T']),
    team_a_id: z.string(),
    team_b_id: z.string(),
}).passthrough();

export const BombPayloadSchema = z.object({
    player_id: z.string(),
    player_team: z.enum(['A', 'B']),
    site: z.enum(['A', 'B']),
    time_remaining_sec: z.number().optional(),
}).passthrough();

export const EconomyPayloadSchema = z.object({
    team_a_econ: z.number().int().min(0),
    team_b_econ: z.number().int().min(0),
    team_a_equipment_value: z.number().int().optional(),
    team_b_equipment_value: z.number().int().optional(),
    team_a_buy_type: z.enum(['full', 'force', 'eco', 'pistol']).optional(),
    team_b_buy_type: z.enum(['full', 'force', 'eco', 'pistol']).optional(),
}).passthrough();

// ============================================
// Validation Result Type
// ============================================

export type ValidationSuccess<T> = {
    success: true;
    data: T;
};

export type ValidationError = {
    success: false;
    error: z.ZodError;
};

export type ValidationResult<T> = ValidationSuccess<T> | ValidationError;

// ============================================
// Validation Functions
// ============================================

/**
 * Validate event with size limit check
 */
export function validateEvent(input: unknown): ValidationResult<BaseEventOutput> {
    // Check payload size first
    const jsonSize = JSON.stringify(input).length;
    if (jsonSize > PAYLOAD_LIMITS.MAX_EVENT_SIZE_BYTES) {
        return {
            success: false,
            error: new z.ZodError([{
                code: 'custom',
                message: `Event payload too large: ${jsonSize} bytes (max: ${PAYLOAD_LIMITS.MAX_EVENT_SIZE_BYTES})`,
                path: [],
            }]),
        };
    }

    const result = BaseEventSchema.safeParse(input);

    if (result.success) {
        return { success: true, data: result.data };
    }

    return { success: false, error: result.error };
}

/**
 * Validate event with typed payload
 */
export function validateTypedEvent<T extends Record<string, unknown>>(
    input: unknown,
    payloadSchema: z.ZodSchema<T>
): ValidationResult<BaseEventOutput & { payload: T }> {
    const baseResult = validateEvent(input);

    if (!baseResult.success) {
        return baseResult;
    }

    const payloadResult = payloadSchema.safeParse(baseResult.data.payload);

    if (!payloadResult.success) {
        return { success: false, error: payloadResult.error };
    }

    return {
        success: true,
        data: { ...baseResult.data, payload: payloadResult.data },
    };
}

/**
 * Check if schema version is supported
 */
export function isSchemaVersionSupported(version: string): boolean {
    return SUPPORTED_SCHEMA_VERSIONS.includes(version as typeof SUPPORTED_SCHEMA_VERSIONS[number]);
}

/**
 * Get payload schema by event type
 */
export function getPayloadSchema(eventType: string): z.ZodSchema<Record<string, unknown>> | null {
    switch (eventType) {
        case 'kill':
            return KillPayloadSchema;
        case 'round_end':
            return RoundEndPayloadSchema;
        case 'round_start':
            return RoundStartPayloadSchema;
        case 'bomb_planted':
        case 'bomb_defused':
        case 'bomb_exploded':
            return BombPayloadSchema;
        case 'economy_update':
            return EconomyPayloadSchema;
        default:
            return null;
    }
}

// Re-export for backwards compatibility
export { BaseEventSchema as EventSchema };
