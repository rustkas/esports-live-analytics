/**
 * API Contract Tests
 * Verifies that the running API conforms to the expected contract.
 * 
 * Usage: API_URL=http://localhost:8080/api/v1 bun scripts/test-contract.ts
 */

const BASE_URL = process.env.API_URL || 'http://localhost:8080/api/v1';
// Public status is at root
const STATUS_URL = process.env.STATUS_URL || 'http://localhost:8080/status';

async function test(name: string, fn: () => Promise<void>) {
    try {
        await fn();
        console.log(`✅ ${name}`);
    } catch (e: any) {
        console.error(`❌ ${name}: ${e.message}`);
        console.error(e.cause ? e.cause : '');
        process.exit(1);
    }
}

async function fetchJson(path: string) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
    return res.json();
}

console.log(`🚀 Starting Contract Tests against ${BASE_URL}`);

// 1. Status Endpoint
test('GET /status', async () => {
    const data = await fetchJson(STATUS_URL) as any;
    if (data.status !== 'operational') throw new Error('Status not operational');
    if (!data.version) throw new Error('Missing version');
    if (!data.timestamp) throw new Error('Missing timestamp');
});

// 2. Live Matches (Public? No, protected by Auth usually. If protected, we need key.)
// Assuming we run this in CI with a seeded key.
const API_KEY = process.env.TEST_API_KEY;

async function fetchProtected(path: string) {
    if (!API_KEY) {
        console.warn('⚠️ Skipping protected test (TEST_API_KEY not set)');
        return null;
    }
    const res = await fetch(`${BASE_URL}${path}`, {
        headers: { 'Authorization': `Bearer ${API_KEY}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
    return res.json();
}

test('GET /live-matches', async () => {
    const data = await fetchProtected('/live-matches') as any;
    if (!data) return;

    if (!Array.isArray(data.data)) throw new Error('Data is not array');
    // Check match structure if non-empty
    if (data.data.length > 0) {
        const m = data.data[0];
        if (!m.id) throw new Error('Match missing id');
        if (!m.team_a_maps_won === undefined) throw new Error('Match missing score');
    }
});

test('GET /teams (List)', async () => {
    const data = await fetchProtected('/teams') as any;
    if (!data) return;
    if (!Array.isArray(data.data)) throw new Error('Data is not array');
});

test('404 Handling', async () => {
    if (!API_KEY) return;
    const res = await fetch(`${BASE_URL}/non-existent-endpoint`, {
        headers: { 'Authorization': `Bearer ${API_KEY}` }
    });
    if (res.status !== 404) throw new Error(`Expected 404, got ${res.status}`);
});
