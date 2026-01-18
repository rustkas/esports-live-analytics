/**
 * Match Replay Service
 * Re-processes raw events from ClickHouse to rebuild state or verify integrity.
 */

import { createClient } from '@clickhouse/client';
import type { Redis } from 'ioredis';
import type { BaseEvent, MatchState } from '@esports/shared';
import { createLogger, REDIS_KEYS } from '@esports/shared';
import { createStateManager } from './state';
import { config } from './config';

const logger = createLogger('state-consumer:replay', config.logLevel as 'debug' | 'info');

export interface ReplayResult {
    match_id: string;
    events_processed: number;
    final_state: MatchState;
    duration_ms: number;
    diffs?: any[];
}

export function createReplayService(redis: Redis) {
    const ch = createClient({
        host: config.clickhouse.url,
        database: config.clickhouse.database,
    });

    const stateManager = createStateManager(redis);

    async function replayMatch(matchId: string, namespace = 'replay'): Promise<ReplayResult> {
        const start = Date.now();
        logger.info('Starting replay', { matchId, namespace });

        // 1. Fetch all events from ClickHouse
        const resultSet = await ch.query({
            query: `
                SELECT * FROM cs2_events_raw 
                WHERE match_id = {matchId:String} 
                ORDER BY seq_no ASC, ts_event ASC
            `,
            query_params: { matchId },
            format: 'JSONEachRow',
        });

        const events = await resultSet.json<any[]>();
        logger.info('Fetched events for replay', { count: events.length });

        if (events.length === 0) {
            throw new Error('No events found for match');
        }

        // 2. Initialize State
        // We handle namespace by using a custom prefix for keys?
        // StateManager uses REDIS_KEYS which are hardcoded constants (Step 1250).
        // I cannot easily change namespace without refactoring StateManager or Redis.
        // Quick fix: Use a Proxy Redis client that prefixes keys?

        const redisProxy = new Proxy(redis, {
            get(target, prop) {
                if (prop === 'get' || prop === 'set' || prop === 'del') {
                    return async (key: string, ...args: any[]) => {
                        // Inject namespace
                        const newKey = `${namespace}:${key}`;
                        return (target as any)[prop](newKey, ...args);
                    };
                }
                return (target as any)[prop];
            }
        });

        // Re-create manager with proxy
        const scopedManager = createStateManager(redisProxy as Redis);

        // 3. Process Events
        let currentState: MatchState | null = null;
        let processed = 0;

        for (const raw of events) {
            // Map CH row to BaseEvent
            const event: BaseEvent = {
                event_id: raw.event_id,
                match_id: raw.match_id,
                map_id: raw.map_id,
                round_no: raw.round_no,
                ts_event: raw.ts_event,
                type: raw.type,
                source: 'replay',
                seq_no: parseInt(raw.seq_no, 10),
                payload: typeof raw.payload === 'string' ? JSON.parse(raw.payload) : raw.payload,
            };

            currentState = await scopedManager.updateMatchState(event);
            processed++;
        }

        const duration = Date.now() - start;
        logger.info('Replay completed', { matchId, duration });

        // Compare with Live State
        const liveKey = REDIS_KEYS.matchState(matchId);
        const liveData = await redis.get(liveKey);
        const liveState = liveData ? JSON.parse(liveData) as MatchState : null;

        const diffs: any[] = [];
        if (liveState && currentState) {
            if (liveState.team_a.score !== currentState.team_a.score)
                diffs.push({ field: 'team_a.score', live: liveState.team_a.score, replay: currentState.team_a.score });
            if (liveState.team_b.score !== currentState.team_b.score)
                diffs.push({ field: 'team_b.score', live: liveState.team_b.score, replay: currentState.team_b.score });
            if (liveState.round_no !== currentState.round_no)
                diffs.push({ field: 'round_no', live: liveState.round_no, replay: currentState.round_no });
            // Add more critical fields as needed
        }

        return {
            match_id: matchId,
            events_processed: processed,
            final_state: currentState!,
            duration_ms: duration,
            diffs
        };
    }

    return { replayMatch };
}
