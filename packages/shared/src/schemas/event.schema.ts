import { z } from 'zod';

/**
 * Zod schemas for event validation
 * Used by ingestion service for input validation
 */

// ============================================
// Event Types Enum
// ============================================

export const EventTypeSchema = z.enum([
    'match_start',
    'match_end',
    'map_start',
    'map_end',
    'round_start',
    'round_end',
    'kill',
    'death',
    'assist',
    'bomb_planted',
    'bomb_defused',
    'bomb_exploded',
    'player_hurt',
    'freeze_time_ended',
    'timeout_start',
    'timeout_end',
    'economy_update',
]);

// ============================================
// Base Event Schema
// ============================================

export const BaseEventSchema = z.object({
    event_id: z.string().uuid(),
    match_id: z.string().uuid(),
    map_id: z.string().uuid(),
    round_no: z.number().int().min(0).max(100),
    ts_event: z.string().datetime(),
    ts_ingest: z.string().datetime().optional(),
    type: EventTypeSchema,
    source: z.string().min(1).max(50),
    seq_no: z.number().int().min(0),
    payload: z.record(z.unknown()),
});

// ============================================
// Payload Schemas
// ============================================

export const TeamSchema = z.enum(['A', 'B']);

export const KillPayloadSchema = z.object({
    killer_player_id: z.string(),
    killer_team: TeamSchema,
    victim_player_id: z.string(),
    victim_team: TeamSchema,
    weapon: z.string(),
    is_headshot: z.boolean().default(false),
    is_wallbang: z.boolean().optional().default(false),
    is_through_smoke: z.boolean().optional().default(false),
    is_no_scope: z.boolean().optional().default(false),
    is_first_kill: z.boolean().optional().default(false),
    attacker_blind: z.boolean().optional().default(false),
    team_a_id: z.string().uuid().optional(),
    team_b_id: z.string().uuid().optional(),
});

export const RoundEndPayloadSchema = z.object({
    winner_team: TeamSchema,
    win_reason: z.enum(['elimination', 'bomb_exploded', 'bomb_defused', 'time_expired']),
    team_a_score: z.number().int().min(0),
    team_b_score: z.number().int().min(0),
    team_a_alive: z.number().int().min(0).max(5).optional(),
    team_b_alive: z.number().int().min(0).max(5).optional(),
    team_a_id: z.string().uuid(),
    team_b_id: z.string().uuid(),
});

export const RoundStartPayloadSchema = z.object({
    team_a_score: z.number().int().min(0),
    team_b_score: z.number().int().min(0),
    team_a_side: z.enum(['CT', 'T']),
    team_b_side: z.enum(['CT', 'T']),
    team_a_id: z.string().uuid(),
    team_b_id: z.string().uuid(),
});

export const BombPayloadSchema = z.object({
    player_id: z.string(),
    player_team: TeamSchema,
    site: TeamSchema,
    time_remaining_sec: z.number().optional(),
});

export const EconomyPayloadSchema = z.object({
    team_a_econ: z.number().int(),
    team_b_econ: z.number().int(),
    team_a_equipment_value: z.number().int().optional(),
    team_b_equipment_value: z.number().int().optional(),
    team_a_buy_type: z.enum(['full', 'force', 'eco', 'pistol']).optional(),
    team_b_buy_type: z.enum(['full', 'force', 'eco', 'pistol']).optional(),
});

export const PlayerHurtPayloadSchema = z.object({
    attacker_player_id: z.string(),
    attacker_team: TeamSchema,
    victim_player_id: z.string(),
    victim_team: TeamSchema,
    damage: z.number().int().min(0),
    damage_armor: z.number().int().min(0).optional(),
    weapon: z.string(),
    hitgroup: z.string().optional(),
});

export const MapPayloadSchema = z.object({
    map_name: z.string(),
    map_number: z.number().int().min(1),
    team_a_id: z.string().uuid(),
    team_b_id: z.string().uuid(),
});

export const MatchPayloadSchema = z.object({
    tournament: z.string().optional(),
    format: z.enum(['bo1', 'bo3', 'bo5']).optional(),
    team_a_id: z.string().uuid(),
    team_b_id: z.string().uuid(),
    team_a_name: z.string().optional(),
    team_b_name: z.string().optional(),
});

// ============================================
// Typed Event Schemas
// ============================================

export const KillEventSchema = BaseEventSchema.extend({
    type: z.literal('kill'),
    payload: KillPayloadSchema,
});

export const RoundEndEventSchema = BaseEventSchema.extend({
    type: z.literal('round_end'),
    payload: RoundEndPayloadSchema,
});

export const RoundStartEventSchema = BaseEventSchema.extend({
    type: z.literal('round_start'),
    payload: RoundStartPayloadSchema,
});

export const BombPlantedEventSchema = BaseEventSchema.extend({
    type: z.literal('bomb_planted'),
    payload: BombPayloadSchema,
});

export const EconomyEventSchema = BaseEventSchema.extend({
    type: z.literal('economy_update'),
    payload: EconomyPayloadSchema,
});

// ============================================
// Union Schema (for generic validation)
// ============================================

export const GameEventSchema = z.discriminatedUnion('type', [
    KillEventSchema,
    RoundEndEventSchema,
    RoundStartEventSchema,
    BombPlantedEventSchema,
    EconomyEventSchema,
    // Fallback for less-typed events
    BaseEventSchema.extend({
        type: z.enum([
            'match_start', 'match_end', 'map_start', 'map_end',
            'death', 'assist', 'bomb_defused', 'bomb_exploded',
            'player_hurt', 'freeze_time_ended', 'timeout_start', 'timeout_end',
        ]),
    }),
]);

// ============================================
// Type Exports
// ============================================

export type EventType = z.infer<typeof EventTypeSchema>;
export type BaseEvent = z.infer<typeof BaseEventSchema>;
export type KillPayload = z.infer<typeof KillPayloadSchema>;
export type RoundEndPayload = z.infer<typeof RoundEndPayloadSchema>;
export type RoundStartPayload = z.infer<typeof RoundStartPayloadSchema>;
export type KillEvent = z.infer<typeof KillEventSchema>;
export type RoundEndEvent = z.infer<typeof RoundEndEventSchema>;
export type RoundStartEvent = z.infer<typeof RoundStartEventSchema>;
export type GameEvent = z.infer<typeof GameEventSchema>;

// ============================================
// Validation Helper
// ============================================

export function validateEvent(data: unknown): { success: true; data: BaseEvent } | { success: false; error: z.ZodError } {
    const result = BaseEventSchema.safeParse(data);
    if (result.success) {
        return { success: true, data: result.data };
    }
    return { success: false, error: result.error };
}

export function validateTypedEvent(data: unknown): { success: true; data: GameEvent } | { success: false; error: z.ZodError } {
    const result = GameEventSchema.safeParse(data);
    if (result.success) {
        return { success: true, data: result.data };
    }
    return { success: false, error: result.error };
}
