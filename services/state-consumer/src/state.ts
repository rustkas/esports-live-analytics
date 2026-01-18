/**
 * Live Match State Manager
 * Maintains current state of all live matches in Redis
 */

import type { Redis } from 'ioredis';
import type { BaseEvent, MatchState, RoundResult } from '@esports/shared';
import { REDIS_KEYS, CS2, createLogger } from '@esports/shared';
import { config } from './config';

const logger = createLogger('state-consumer:state', config.logLevel as 'debug' | 'info');

export interface StateManager {
    getMatchState(matchId: string): Promise<MatchState | null>;
    updateMatchState(event: BaseEvent): Promise<MatchState>;
    publishStateUpdate(matchId: string, state: MatchState): Promise<void>;
}

export function createStateManager(redis: Redis): StateManager {

    async function getMatchState(matchId: string): Promise<MatchState | null> {
        const key = REDIS_KEYS.matchState(matchId);
        const data = await redis.get(key);

        if (!data) {
            return null;
        }

        return JSON.parse(data) as MatchState;
    }

    async function saveMatchState(state: MatchState): Promise<void> {
        const key = REDIS_KEYS.matchState(state.match_id);
        await redis.set(key, JSON.stringify(state), 'EX', 86400); // 24 hour TTL
    }

    async function updateMatchState(event: BaseEvent): Promise<MatchState> {
        // Get current state or create new one
        let state = await getMatchState(event.match_id);

        if (!state) {
            state = createInitialState(event);
        }

        // Update state based on event type
        state = applyEvent(state, event);

        // Save updated state
        await saveMatchState(state);

        logger.debug('State updated', {
            match_id: event.match_id,
            event_type: event.type,
            round: state.current_round,
            score: `${state.team_a_score}-${state.team_b_score}`,
        });

        return state;
    }

    async function publishStateUpdate(matchId: string, state: MatchState): Promise<void> {
        const channel = REDIS_KEYS.matchUpdates(matchId);
        await redis.publish(channel, JSON.stringify({
            type: 'state',
            match_id: matchId,
            timestamp: new Date().toISOString(),
            data: state,
        }));
    }

    return {
        getMatchState,
        updateMatchState,
        publishStateUpdate,
    };
}

/**
 * Create initial state for a new match
 */
function createInitialState(event: BaseEvent): MatchState {
    const payload = event.payload as Record<string, unknown>;

    return {
        match_id: event.match_id,
        map_id: event.map_id,

        team_a_id: (payload.team_a_id as string) ?? 'unknown-a',
        team_b_id: (payload.team_b_id as string) ?? 'unknown-b',

        team_a_score: 0,
        team_b_score: 0,
        current_round: event.round_no || 1,

        round_phase: 'warmup',
        team_a_alive: CS2.PLAYERS_PER_TEAM,
        team_b_alive: CS2.PLAYERS_PER_TEAM,

        team_a_econ: CS2.STARTING_MONEY * CS2.PLAYERS_PER_TEAM,
        team_b_econ: CS2.STARTING_MONEY * CS2.PLAYERS_PER_TEAM,

        team_a_side: 'CT',

        team_a_kills_round: 0,
        team_b_kills_round: 0,
        team_a_kills_total: 0,
        team_b_kills_total: 0,

        bomb_planted: false,

        last_event_id: event.event_id,
        last_event_at: event.ts_event,

        round_history: [],
    };
}

/**
 * Apply event to state and return updated state
 */
function applyEvent(state: MatchState, event: BaseEvent): MatchState {
    const payload = event.payload as Record<string, unknown>;

    // Always update last event
    state.last_event_id = event.event_id;
    state.last_event_at = event.ts_event;

    switch (event.type) {
        case 'round_start':
            return {
                ...state,
                current_round: event.round_no,
                round_phase: 'freeze',
                team_a_alive: CS2.PLAYERS_PER_TEAM,
                team_b_alive: CS2.PLAYERS_PER_TEAM,
                team_a_kills_round: 0,
                team_b_kills_round: 0,
                bomb_planted: false,
                bomb_site: undefined,
                team_a_score: (payload.team_a_score as number) ?? state.team_a_score,
                team_b_score: (payload.team_b_score as number) ?? state.team_b_score,
                team_a_side: (payload.team_a_side as 'CT' | 'T') ?? state.team_a_side,
            };

        case 'freeze_time_ended':
            return {
                ...state,
                round_phase: 'live',
            };

        case 'kill': {
            const killerTeam = payload.killer_team as 'A' | 'B';
            const victimTeam = payload.victim_team as 'A' | 'B';

            return {
                ...state,
                team_a_kills_round: killerTeam === 'A' ? state.team_a_kills_round + 1 : state.team_a_kills_round,
                team_b_kills_round: killerTeam === 'B' ? state.team_b_kills_round + 1 : state.team_b_kills_round,
                team_a_kills_total: killerTeam === 'A' ? state.team_a_kills_total + 1 : state.team_a_kills_total,
                team_b_kills_total: killerTeam === 'B' ? state.team_b_kills_total + 1 : state.team_b_kills_total,
                team_a_alive: victimTeam === 'A' ? state.team_a_alive - 1 : state.team_a_alive,
                team_b_alive: victimTeam === 'B' ? state.team_b_alive - 1 : state.team_b_alive,
            };
        }

        case 'bomb_planted':
            return {
                ...state,
                bomb_planted: true,
                bomb_site: payload.site as 'A' | 'B',
            };

        case 'bomb_defused':
        case 'bomb_exploded':
            return {
                ...state,
                bomb_planted: false,
            };

        case 'round_end': {
            const winnerTeam = payload.winner_team as 'A' | 'B';
            const newScore = {
                team_a_score: (payload.team_a_score as number) ?? (winnerTeam === 'A' ? state.team_a_score + 1 : state.team_a_score),
                team_b_score: (payload.team_b_score as number) ?? (winnerTeam === 'B' ? state.team_b_score + 1 : state.team_b_score),
            };

            const roundResult: RoundResult = {
                round_no: event.round_no,
                winner: winnerTeam,
                win_reason: (payload.win_reason as string) ?? 'unknown',
                team_a_kills: state.team_a_kills_round,
                team_b_kills: state.team_b_kills_round,
            };

            return {
                ...state,
                ...newScore,
                round_phase: 'over',
                bomb_planted: false,
                round_history: [...state.round_history, roundResult],
            };
        }

        case 'economy_update':
            return {
                ...state,
                team_a_econ: (payload.team_a_econ as number) ?? state.team_a_econ,
                team_b_econ: (payload.team_b_econ as number) ?? state.team_b_econ,
            };

        default:
            return state;
    }
}
