/**
 * CS2 Event Types
 * Core event definitions for live match data processing
 */

// ============================================
// Event Types (as they appear in type field)
// ============================================
export type EventType =
    | 'match_start'
    | 'match_end'
    | 'map_start'
    | 'map_end'
    | 'round_start'
    | 'round_end'
    | 'kill'
    | 'death'
    | 'assist'
    | 'bomb_planted'
    | 'bomb_defused'
    | 'bomb_exploded'
    | 'player_hurt'
    | 'freeze_time_ended'
    | 'timeout_start'
    | 'timeout_end'
    | 'economy_update';

// ============================================
// Base Event Structure
// ============================================
export interface BaseEvent {
    /** Unique event identifier (for idempotency) */
    event_id: string;

    /** Match identifier */
    match_id: string;

    /** Map identifier within match */
    map_id: string;

    /** Current round number */
    round_no: number;

    /** When the event occurred (game time) */
    ts_event: string;

    /** When we received the event */
    ts_ingest?: string;

    /** Event type */
    type: EventType;

    /** Data source/provider */
    source: string;

    /** Sequence number from provider (for ordering) */
    seq_no: number;

    /** Event-specific data */
    payload: Record<string, unknown>;
}

// ============================================
// Typed Event Payloads
// ============================================

export interface KillPayload {
    killer_player_id: string;
    killer_team: 'A' | 'B';
    victim_player_id: string;
    victim_team: 'A' | 'B';
    weapon: string;
    is_headshot: boolean;
    is_wallbang: boolean;
    is_through_smoke: boolean;
    is_no_scope: boolean;
    is_first_kill: boolean;
    attacker_blind: boolean;
    team_a_id?: string;
    team_b_id?: string;
}

export interface RoundEndPayload {
    winner_team: 'A' | 'B';
    win_reason: 'elimination' | 'bomb_exploded' | 'bomb_defused' | 'time_expired';
    team_a_score: number;
    team_b_score: number;
    team_a_alive: number;
    team_b_alive: number;
    team_a_id: string;
    team_b_id: string;
}

export interface BombPayload {
    player_id: string;
    player_team: 'A' | 'B';
    site: 'A' | 'B';
    time_remaining_sec?: number;
}

export interface EconomyPayload {
    team_a_econ: number;
    team_b_econ: number;
    team_a_equipment_value: number;
    team_b_equipment_value: number;
    team_a_buy_type: 'full' | 'force' | 'eco' | 'pistol';
    team_b_buy_type: 'full' | 'force' | 'eco' | 'pistol';
}

export interface PlayerHurtPayload {
    attacker_player_id: string;
    attacker_team: 'A' | 'B';
    victim_player_id: string;
    victim_team: 'A' | 'B';
    damage: number;
    damage_armor: number;
    weapon: string;
    hitgroup: string;
}

export interface RoundStartPayload {
    team_a_score: number;
    team_b_score: number;
    team_a_side: 'CT' | 'T';
    team_b_side: 'CT' | 'T';
    team_a_id: string;
    team_b_id: string;
}

export interface MapPayload {
    map_name: string;
    map_number: number;
    team_a_id: string;
    team_b_id: string;
}

export interface MatchPayload {
    tournament: string;
    format: 'bo1' | 'bo3' | 'bo5';
    team_a_id: string;
    team_b_id: string;
    team_a_name: string;
    team_b_name: string;
}

// ============================================
// Typed Events
// ============================================

export interface KillEvent extends BaseEvent {
    type: 'kill';
    payload: KillPayload;
}

export interface RoundEndEvent extends BaseEvent {
    type: 'round_end';
    payload: RoundEndPayload;
}

export interface RoundStartEvent extends BaseEvent {
    type: 'round_start';
    payload: RoundStartPayload;
}

export interface BombPlantedEvent extends BaseEvent {
    type: 'bomb_planted';
    payload: BombPayload;
}

export interface BombDefusedEvent extends BaseEvent {
    type: 'bomb_defused';
    payload: BombPayload;
}

export interface EconomyEvent extends BaseEvent {
    type: 'economy_update';
    payload: EconomyPayload;
}

export interface PlayerHurtEvent extends BaseEvent {
    type: 'player_hurt';
    payload: PlayerHurtPayload;
}

export interface MapStartEvent extends BaseEvent {
    type: 'map_start';
    payload: MapPayload;
}

export interface MapEndEvent extends BaseEvent {
    type: 'map_end';
    payload: MapPayload & { winner_team: 'A' | 'B'; team_a_score: number; team_b_score: number };
}

export interface MatchStartEvent extends BaseEvent {
    type: 'match_start';
    payload: MatchPayload;
}

export interface MatchEndEvent extends BaseEvent {
    type: 'match_end';
    payload: MatchPayload & { winner_team: 'A' | 'B'; team_a_maps: number; team_b_maps: number };
}

// ============================================
// Union Type
// ============================================

export type GameEvent =
    | KillEvent
    | RoundEndEvent
    | RoundStartEvent
    | BombPlantedEvent
    | BombDefusedEvent
    | EconomyEvent
    | PlayerHurtEvent
    | MapStartEvent
    | MapEndEvent
    | MatchStartEvent
    | MatchEndEvent
    | BaseEvent; // fallback for unknown events
