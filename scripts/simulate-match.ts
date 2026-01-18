/**
 * Match Simulator
 * Generates a stream of events for a demo match to test the pipeline.
 * 
 * Usage: bun scripts/simulate-match.ts
 */

const INGESTION_URL = 'http://localhost:3000/events';
const MATCH_ID = '11111111-1111-1111-1111-111111111111'; // Key from seed
const MAP_ID = '22222222-2222-2222-2222-222222222222';

async function send(type: string, payload: any) {
    const event = {
        type,
        match_id: MATCH_ID,
        data: payload,
        timestamp: new Date().toISOString()
    };

    try {
        const res = await fetch(INGESTION_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(event)
        });
        console.log(`[${type}] ${res.status}`);
    } catch (e) {
        console.error(`[${type}] Failed: ${e}`);
    }
}

async function sleep(ms: number) {
    return new Promise(r => setTimeout(r, ms));
}

async function run() {
    console.log('🚀 Starting Match Simulation...');

    // 1. Match Start
    await send('match_start', { map: 'de_mirage' });
    await sleep(2000);

    // 2. Round 1 Start
    await send('round_start', { round: 1 });
    await sleep(1000);

    // 3. Kills (Team A wins pistol)
    await send('kill', { killer_team: 'A', victim_team: 'B' });
    await sleep(500);
    await send('kill', { killer_team: 'A', victim_team: 'B' });
    await sleep(500);
    await send('kill', { killer_team: 'A', victim_team: 'B' });

    // 4. Bomb Plant
    await send('bomb_planted', { site: 'A' });
    await sleep(2000);

    // 5. Round End
    await send('round_end', { winner: 'A', reason: 'bomb_exploded' });

    console.log('✅ Simulation Complete');
}

run();
