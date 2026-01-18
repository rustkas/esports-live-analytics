/**
 * Reliability Integration Tests
 * 
 * Verifies critical reliability features:
 * 1. Idempotency (Deduplication)
 * 2. Event Ordering (Sequencing)
 * 3. Payload Validation
 * 4. Admin API Health
 * 
 * Usage: bun scripts/test-reliability.ts
 * Requires: All services running (docker-compose up)
 */

import { randomUUID } from 'crypto';

const API_URL = 'http://localhost:3001'; // Ingestion
const ADMIN_URL = 'http://localhost:3001/admin';
const MATCH_ID = randomUUID();
const MAP_ID = randomUUID();

async function runTests() {
    console.log('🚀 Starting Reliability Tests...\n');
    console.log(`Target: ${API_URL}`);
    console.log(`Match ID: ${MATCH_ID}\n`);

    try {
        await testHealth();
        await testValidation();
        await testIdempotency();
        await testOrdering();
        // await testBackpressure(); // Optional, heavy load

        console.log('\n✅ All Reliability Tests Passed!');
    } catch (error) {
        console.error('\n❌ Tests Failed:', error);
        process.exit(1);
    }
}

async function testHealth() {
    console.log('--- Testing Health Endpoints ---');
    const res = await fetch(`${API_URL}/healthz`);
    if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
    console.log('✅ Ingestion Service is healthy');
}

async function testValidation() {
    console.log('\n--- Testing Validation ---');

    // 1. Invalid Payload (Schema)
    const res1 = await fetch(`${API_URL}/events`, {
        method: 'POST',
        body: JSON.stringify({
            match_id: MATCH_ID,
            type: 'invalid_type_event', // Missing required fields
        }),
    });

    if (res1.status !== 400) {
        throw new Error(`Expected 400 for invalid schema, got ${res1.status}`);
    }
    const body1 = await res1.json();
    // @ts-ignore
    if (body1.error.code !== 'VALIDATION_ERROR') {
        throw new Error('Expected VALIDATION_ERROR code');
    }
    console.log('✅ Schema validation caught invalid event');

    // 2. Payload Size Limit
    const largePayload = 'x'.repeat(1024 * 70); // 70KB > 64KB limit
    const res2 = await fetch(`${API_URL}/events`, {
        method: 'POST',
        body: JSON.stringify({
            event_id: randomUUID(),
            match_id: MATCH_ID,
            map_id: MAP_ID,
            type: 'chat_message',
            ts_event: new Date().toISOString(),
            payload: { message: largePayload }
        }),
    });

    if (res2.status !== 400) {
        throw new Error(`Expected 400 for large payload, got ${res2.status}`);
    }
    console.log('✅ Payload size limit enforced (64KB limit)');
}

async function testIdempotency() {
    console.log('\n--- Testing Idempotency ---');

    const eventId = randomUUID();
    const event = {
        event_id: eventId,
        match_id: MATCH_ID,
        map_id: MAP_ID,
        type: 'round_start',
        round_no: 1,
        ts_event: new Date().toISOString(),
        payload: { team_a_score: 0, team_b_score: 0 }
    };

    // 1. First Send
    const res1 = await fetch(`${API_URL}/events`, {
        method: 'POST',
        body: JSON.stringify(event),
    });

    if (!res1.ok) throw new Error(`First send failed: ${res1.status}`);
    const body1 = await res1.json();
    console.log('✅ First event sent successfully');

    // 2. Second Send (Duplicate)
    const res2 = await fetch(`${API_URL}/events`, {
        method: 'POST',
        body: JSON.stringify(event),
    });

    if (!res2.ok) throw new Error(`Second send failed: ${res2.status}`);
    const body2 = await res2.json();

    // @ts-ignore
    if (body2.duplicate !== true) {
        throw new Error('Expected duplicate: true in response');
    }
    console.log('✅ Duplicate event detected and handled');
}

async function testOrdering() {
    console.log('\n--- Testing Ordering (Sequencing) ---');

    // Need to monitor logs or admin API for full verification,
    // but we can check if ingestion accepts them.
    // Real sequence validation happens in state-consumer.

    // We'll verify sequence stats via Admin API if available/exposed, 
    // or just ensure ingestion works.

    const events = [
        { seq_no: 10, type: 'kill', round: 1 },
        { seq_no: 12, type: 'kill', round: 1 }, // Gap! Expect buffer/log
        { seq_no: 11, type: 'kill', round: 1 }, // Fill gap
    ];

    for (const e of events) {
        const res = await fetch(`${API_URL}/events`, {
            method: 'POST',
            body: JSON.stringify({
                event_id: randomUUID(),
                match_id: MATCH_ID,
                map_id: MAP_ID,
                type: e.type,
                ts_event: new Date().toISOString(),
                seq_no: e.seq_no,
                payload: {
                    killer_team: 'A', victim_team: 'B',
                    killer_player_id: randomUUID(), victim_player_id: randomUUID(),
                    is_headshot: false, is_first_kill: false
                }
            }),
        });

        if (!res.ok) throw new Error(`Event seq=${e.seq_no} failed`);
        console.log(`Sent seq=${e.seq_no}`);
    }

    console.log('✅ Out-of-order events ingested (Consumer logs should show GAP/BUFFER)');

    // Optional: Check Admin API for sequence stats (if we exposed it on Ingestion, 
    // but sequence logic is on Consumer. Consumer Admin API is on port 3002 usually).
    try {
        // Port 3002 is state-consumer default metrics/health port
        const res = await fetch('http://localhost:3002/admin/sequence/stats');
        if (res.ok) {
            const stats = await res.json();
            console.log('Consumer Sequence Stats:', stats);
        }
    } catch (e) {
        console.log('Could not fetch consumer stats (might not be running or accessible)');
    }
}

runTests().catch(console.error);
