/**
 * k6 Load Test Script
 * usage: k6 run scripts/k6-load-test.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
    stages: [
        { duration: '10s', target: 50 },  // Ramp up to 50 users (~500 req/s if 10Hz)
        { duration: '30s', target: 50 },  // Stay at 50 users
        { duration: '10s', target: 200 }, // Spike to 200 users (~2000 req/s)
        { duration: '30s', target: 200 }, // Stay
        { duration: '10s', target: 0 },   // Ramp down
    ],
    thresholds: {
        http_req_duration: ['p(95)<50', 'p(99)<200'], // 95% < 50ms
        http_req_failed: ['rate<0.01'],    // Error rate < 1%
    },
};

const BASE_URL = __ENV.API_URL || 'http://localhost:8081';

export default function () {
    const payload = JSON.stringify({
        event_id: `evt-${Date.now()}-${__VU}-${__ITER}`,
        match_id: '11111111-1111-1111-1111-111111111111',
        map_id: '22222222-2222-2222-2222-222222222222',
        type: 'kill',
        ts_event: new Date().toISOString(),
        source: 'load-test',
        payload: {
            killer: 'p1',
            victim: 'p2',
            weapon: 'ak47'
        }
    });

    const params = {
        headers: {
            'Content-Type': 'application/json',
        },
    };

    const res = http.post(`${BASE_URL}/events`, payload, params);

    check(res, {
        'status is 200': (r) => r.status === 200,
    });

    // Target 10 requests per second per VU
    sleep(0.1);
}
