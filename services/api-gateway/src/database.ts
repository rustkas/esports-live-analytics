/**
 * PostgreSQL Database Client
 */

import { Pool } from 'pg';
import { createLogger } from '@esports/shared';
import { config } from './config';

const logger = createLogger('api-gateway:db', config.logLevel as 'debug' | 'info');

export function createDatabase(): Pool {
    const pool = new Pool({
        connectionString: config.postgres.url,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
        logger.error('Database pool error', { error: String(err) });
    });

    pool.on('connect', () => {
        logger.debug('New database connection');
    });

    return pool;
}

// Types for database queries
export interface DbMatch {
    id: string;
    team_a_id: string;
    team_b_id: string;
    tournament_name: string | null;
    format: string;
    status: string;
    scheduled_at: Date | null;
    started_at: Date | null;
    finished_at: Date | null;
    team_a_maps_won: number;
    team_b_maps_won: number;
    winner_id: string | null;
}

export interface DbTeam {
    id: string;
    name: string;
    short_name: string | null;
    logo_url: string | null;
    country: string | null;
    rating: number;
}

export interface DbMatchMap {
    id: string;
    match_id: string;
    map_name: string;
    map_number: number;
    status: string;
    team_a_score: number;
    team_b_score: number;
    current_round: number;
    winner_id: string | null;
}
