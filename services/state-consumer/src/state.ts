/**
 * Live Match State Manager
 * Maintains current state of all live matches in Redis
 */

import type { Redis } from 'ioredis';
import type { BaseEvent, MatchState, TeamState } from '@esports/shared';
import { REDIS_KEYS, createLogger } from '@esports/shared';
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
        return data ? JSON.parse(data) as MatchState : null;
    }

    async function saveMatchState(state: MatchState): Promise<void> {
        const key = REDIS_KEYS.matchState(state.match_id);
        await redis.set(key, JSON.stringify(state), 'EX', 86400); // 24h
    }

    async function updateMatchState(event: BaseEvent): Promise<MatchState> {
        let state = await getMatchState(event.match_id);
        if (!state) {
            state = createInitialState(event);
        }

        const newState = applyEvent(state, event);

        // Versioning
        newState.state_version = (state.state_version || 0) + 1;
        newState.last_update_ts = Date.now();

        await saveMatchState(newState);

        logger.debug('State updated', {
            type: event.type,
            version: newState.state_version,
            score: `${newState.team_a.score}-${newState.team_b.score}`
        });

        return newState;
    }

    async function publishStateUpdate(matchId: string, state: MatchState): Promise<void> {
        // Debounce logic is usually in wrapper or predictor, but here we just publish
        await redis.publish(REDIS_KEYS.matchUpdates(matchId), JSON.stringify({
            match_id: matchId,
            timestamp: new Date().toISOString(),
            data: state // Consumers need new schema
        }));
    }

    return { getMatchState, updateMatchState, publishStateUpdate };
}

function createInitialTeamState(id: string, name: string): TeamState {
    return {
        id,
        name,
        score: 0,
        maps_won: 0,
        money: 0, // Will be updated by economy events
        equipment_value: 0,
        consecutive_round_losses: 0,
        timeouts_remaining: 4,
        side: 'CT', // Default, will change
        alive_count: 5,
        strength_rating: 1000,
    };
}

function createInitialState(event: BaseEvent): MatchState {
    const p = event.payload as any;
    return {
        match_id: event.match_id,
        map_id: event.map_id,
        format: p.format || 'bo3',
        team_a: createInitialTeamState(p.team_a_id || 'A', p.team_a_name || 'Team A'),
        team_b: createInitialTeamState(p.team_b_id || 'B', p.team_b_name || 'Team B'),
        round_no: event.round_no || 0,
        phase: 'warmup',
        bomb_planted: false,
        seconds_remaining: 0,
        state_version: 0,
        last_update_ts: Date.now()
    };
}

function applyEvent(state: MatchState, event: BaseEvent): MatchState {
    const s = { ...state }; // Shallow copy
    // Deep copy teams to avoid mutation issues
    s.team_a = { ...state.team_a };
    s.team_b = { ...state.team_b };
    const p = event.payload as any;

    // Common updates
    if (event.round_no > s.round_no) {
        s.round_no = event.round_no;
    }

    switch (event.type) {
        case 'match_start':
            s.team_a.maps_won = 0;
            s.team_b.maps_won = 0;
            break;

        case 'map_start':
            s.map_id = event.map_id;
            s.team_a.score = 0;
            s.team_b.score = 0;
            s.round_no = 1;
            break;

        case 'round_start':
            s.phase = 'live';
            s.team_a.alive_count = 5;
            s.team_b.alive_count = 5;
            s.bomb_planted = false;
            if (p.team_a_side) s.team_a.side = p.team_a_side;
            if (p.team_b_side) s.team_b.side = p.team_b_side;
            break;

        case 'kill':
            if (p.victim_team === 'A' && s.team_a.alive_count > 0) s.team_a.alive_count--;
            if (p.victim_team === 'B' && s.team_b.alive_count > 0) s.team_b.alive_count--;
            break;

        case 'bomb_planted':
            s.phase = 'bomb_planted';
            s.bomb_planted = true;
            s.seconds_remaining = 40;
            break;

        case 'bomb_defused':
        case 'bomb_exploded':
            s.phase = 'ended';
            break;

        case 'round_end':
            s.phase = 'ended';
            // Update scores
            if (p.winner_team === 'A') {
                s.team_a.score++;
                s.team_b.consecutive_round_losses++;
                s.team_a.consecutive_round_losses = 0;
            } else if (p.winner_team === 'B') {
                s.team_b.score++;
                s.team_a.consecutive_round_losses++;
                s.team_b.consecutive_round_losses = 0;
            }
            break;

        case 'map_end':
            if (p.winner_team === 'A') s.team_a.maps_won++;
            if (p.winner_team === 'B') s.team_b.maps_won++;
            break;

        case 'economy_update':
            // Assume we receive current state
            if (typeof p.team_a_econ === 'number') s.team_a.money = p.team_a_econ;
            if (typeof p.team_b_econ === 'number') s.team_b.money = p.team_b_econ;
            if (typeof p.team_a_equipment_value === 'number') s.team_a.equipment_value = p.team_a_equipment_value;
            if (typeof p.team_b_equipment_value === 'number') s.team_b.equipment_value = p.team_b_equipment_value;
            break;
    }

    return s;
}
