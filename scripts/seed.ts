/**
 * Database Seeder
 * Populates PostgreSQL with initial reference data (Teams, Tournaments).
 * 
 * Usage: bun scripts/seed.ts
 */

import { Client } from 'pg';
import { v4 as uuidv4 } from 'uuid';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/esports_analytics';

async function seed() {
    console.log(`🌱 Seeding database at ${DATABASE_URL}...`);

    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();

    try {
        // 1. Teams
        const teams = [
            { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', name: 'Natus Vincere', short: 'NAVI', country: 'UA', rating: 1900 },
            { id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', name: 'FaZe Clan', short: 'FaZe', country: 'US', rating: 1850 },
            { id: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', name: 'Team Vitality', short: 'VIT', country: 'FR', rating: 1800 },
            { id: 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44', name: 'G2 Esports', short: 'G2', country: 'DE', rating: 1750 },
        ];

        for (const t of teams) {
            await client.query(`
                INSERT INTO teams (id, name, short_name, country, rating)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (id) DO UPDATE SET rating = $5
            `, [t.id, t.name, t.short, t.country, t.rating]);
        }
        console.log(`✅ Seeded ${teams.length} teams`);

        // 2. Tournaments
        const tournaments = [
            { id: 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55', name: 'PGL Major Copenhagen 2024', tier: 'S', prize: 1250000 },
            { id: 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66', name: 'IEM Katowice 2024', tier: 'S', prize: 1000000 },
        ];

        for (const t of tournaments) {
            await client.query(`
                INSERT INTO tournaments (id, name, tier, prize_pool)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (id) DO NOTHING
            `, [t.id, t.name, t.tier, t.prize]);
        }
        console.log(`✅ Seeded ${tournaments.length} tournaments`);

        // 3. Demo Match
        const matchId = '11111111-2222-3333-4444-555555555555';
        await client.query(`
            INSERT INTO matches (id, team_a_id, team_b_id, tournament_id, status, scheduled_at, source, external_id)
            VALUES ($1, $2, $3, $4, 'scheduled', NOW() + INTERVAL '1 hour', 'demo', 'demo_1')
            ON CONFLICT (source, external_id) DO NOTHING
        `, [matchId, teams[0].id, teams[1].id, tournaments[0].id]);
        console.log('✅ Seeded demo match');

    } catch (err) {
        console.error('❌ Seeding failed:', err);
    } finally {
        await client.end();
    }
}

seed();
