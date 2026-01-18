/**
 * k6 Load Test Script
 * 
 * Run with: k6 run scripts/k6-test.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// Custom metrics
const errorRate = new Rate('errors');
const latency = new Trend('latency_ms');

// Test options
export const options = {
    scenarios: {
        // Smoke test
        smoke: {
            executor: 'constant-vus',
            vus: 1,
            duration: '10s',
            startTime: '0s',
        },
        // Load test
        load: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: '30s', target: 10 },
                { duration: '1m', target: 50 },
                { duration: '30s', target: 100 },
                { duration: '1m', target: 100 },
                { duration: '30s', target: 0 },
            ],
            startTime: '15s',
        },
    },
    thresholds: {
        http_req_duration: ['p(95)<500'], // 95% of requests under 500ms
        errors: ['rate<0.1'], // Error rate under 10%
    },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8081';
const MATCH_ID = '11111111-1111-1111-1111-111111111111';
const MAP_ID = '22222222-2222-2222-2222-222222222222';
const TEAM_A_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TEAM_B_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function generateEventId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

const eventTypes = ['kill', 'round_start', 'round_end', 'economy_update', 'bomb_planted'];

export default function () {
    const eventType = eventTypes[Math.floor(Math.random() * eventTypes.length)];
    const round = Math.floor(Math.random() * 30) + 1;

    const payload = {
        event_id: generateEventId(),
        match_id: MATCH_ID,
        map_id: MAP_ID,
        round_no: round,
        ts_event: new Date().toISOString(),
        type: eventType,
        source: 'k6-test',
        seq_no: Math.floor(Math.random() * 1000000),
        payload: {
            team_a_id: TEAM_A_ID,
            team_b_id: TEAM_B_ID,
            killer_team: Math.random() > 0.5 ? 'A' : 'B',
            victim_team: Math.random() > 0.5 ? 'A' : 'B',
        },
    };

    const params = {
        headers: {
            'Content-Type': 'application/json',
        },
        timeout: '10s',
    };

    const startTime = new Date().getTime();
    const res = http.post(`${BASE_URL}/events`, JSON.stringify(payload), params);
    const endTime = new Date().getTime();

    latency.add(endTime - startTime);

    const success = check(res, {
        'status is 200': (r) => r.status === 200,
        'response has success': (r) => {
            try {
                return JSON.parse(r.body).success === true;
            } catch {
                return false;
            }
        },
        'latency < 100ms': (r) => r.timings.duration < 100,
    });

    errorRate.add(!success);

    sleep(0.01); // 10ms between requests
}

export function handleSummary(data) {
    return {
        'stdout': textSummary(data, { indent: ' ', enableColors: true }),
        'scripts/k6-results.json': JSON.stringify(data),
    };
}

function textSummary(data, opts) {
    const lines = [
        '',
        '📊 Load Test Summary',
        '===================',
        '',
        `Total requests: ${data.metrics.http_reqs.values.count}`,
        `Request rate: ${data.metrics.http_reqs.values.rate.toFixed(2)}/s`,
        '',
        'Latency:',
        `  - p50: ${data.metrics.http_req_duration.values['p(50)'].toFixed(2)}ms`,
        `  - p95: ${data.metrics.http_req_duration.values['p(95)'].toFixed(2)}ms`,
        `  - p99: ${data.metrics.http_req_duration.values['p(99)'].toFixed(2)}ms`,
        '',
        `Error rate: ${(data.metrics.errors.values.rate * 100).toFixed(2)}%`,
        '',
    ];

    return lines.join('\n');
}
