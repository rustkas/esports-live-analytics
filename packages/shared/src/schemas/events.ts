import { z } from 'zod';

// ==========================================
// Enums
// ==========================================
export const EventTypeSchema = z.enum([
    'match_start', 'match_end', 'map_start', 'map_end',
    'round_start', 'round_end', 'kill', 'death', 'assist',
    'bomb_planted', 'bomb_defused', 'bomb_exploded',
    'player_hurt', 'freeze_time_ended', 'timeout_start',
    'timeout_end', 'economy_update'
]);

export const TeamSideSchema = z.enum(['CT', 'T']);
export const TeamEnumSchema = z.enum(['A', 'B']);

// ==========================================
// Payloads
// ==========================================
export const KillPayloadSchema = z.object({
    killer_player_id: z.string().uuid(),
    killer_team: TeamEnumSchema,
    victim_player_id: z.string().uuid(),
    victim_team: TeamEnumSchema,
    weapon: z.string(),
    is_headshot: z.boolean(),
    is_wallbang: z.boolean().optional(),
    is_through_smoke: z.boolean().optional(),
    is_first_kill: z.boolean().optional(),
    attacker_blind: z.boolean().optional(),
});

export const RoundEndPayloadSchema = z.object({
    winner_team: TeamEnumSchema,
    win_reason: z.enum(['elimination', 'bomb_exploded', 'bomb_defused', 'time_expired']),
    team_a_score: z.number().int(),
    team_b_score: z.number().int(),
});

// ==========================================
// Base Event
// ==========================================
export const EventContextSchema = z.object({
    trace_id: z.string().min(1),
    ingest_pod_id: z.string().optional(),
    processed_at: z.string().datetime().optional()
});

export const NormalizedEventSchema = z.object({
    event_id: z.string().uuid(),
    match_id: z.string().uuid(),
    map_id: z.string().uuid(),
    round_no: z.number().int().min(0),
    ts_event: z.string().datetime(),
    type: EventTypeSchema,
    source: z.string(),
    seq_no: z.number().int().min(0),
    payload: z.record(z.unknown()), // Generic payload container
    context: EventContextSchema.optional(),
});

export function validateEvent(data: unknown) {
    return NormalizedEventSchema.safeParse(data);
}

// ==========================================
// Registry (Map type to payload schema)
// ==========================================
export const EventSchemas = {
    kill: KillPayloadSchema,
    round_end: RoundEndPayloadSchema,
    // others...
};
