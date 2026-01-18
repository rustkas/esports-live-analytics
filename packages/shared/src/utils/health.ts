/**
 * Health Check Handlers
 * 
 * Standard /healthz (liveness) and /readyz (readiness) endpoints.
 * Framework-agnostic implementation.
 */

export interface HealthCheck {
    name: string;
    check: () => Promise<boolean>;
}

export interface HealthStatus {
    status: 'healthy' | 'degraded' | 'unhealthy';
    version: string;
    uptime: number;
    checks: Array<{
        name: string;
        status: 'pass' | 'fail';
        latency_ms?: number;
    }>;
    timestamp: string;
}

export interface HealthResponse {
    status: number;
    body: HealthStatus | { status: string; version: string; uptime: number; timestamp: string };
}

/**
 * Create health check functions
 */
export function createHealthChecks(
    version: string,
    checks: HealthCheck[] = []
) {
    const startTime = Date.now();

    return {
        /**
         * Liveness probe: /healthz
         * Returns 200 if the service is running (even if dependencies are down)
         */
        async healthz(): Promise<HealthResponse> {
            return {
                status: 200,
                body: {
                    status: 'healthy',
                    version,
                    uptime: (Date.now() - startTime) / 1000,
                    timestamp: new Date().toISOString(),
                },
            };
        },

        /**
         * Readiness probe: /readyz
         * Returns 200 only if all dependencies are available
         */
        async readyz(): Promise<HealthResponse> {
            const results: HealthStatus['checks'] = [];
            let allPassing = true;

            for (const { name, check } of checks) {
                const checkStart = performance.now();
                try {
                    const passed = await check();
                    results.push({
                        name,
                        status: passed ? 'pass' : 'fail',
                        latency_ms: Math.round(performance.now() - checkStart),
                    });
                    if (!passed) allPassing = false;
                } catch {
                    results.push({
                        name,
                        status: 'fail',
                        latency_ms: Math.round(performance.now() - checkStart),
                    });
                    allPassing = false;
                }
            }

            const body: HealthStatus = {
                status: allPassing ? 'healthy' : 'unhealthy',
                version,
                uptime: (Date.now() - startTime) / 1000,
                checks: results,
                timestamp: new Date().toISOString(),
            };

            return { status: allPassing ? 200 : 503, body };
        },

        /**
         * Combined health endpoint: /health
         * Detailed status for monitoring dashboards
         */
        async health(): Promise<HealthResponse> {
            const results: HealthStatus['checks'] = [];
            let failCount = 0;

            for (const { name, check } of checks) {
                const checkStart = performance.now();
                try {
                    const passed = await check();
                    results.push({
                        name,
                        status: passed ? 'pass' : 'fail',
                        latency_ms: Math.round(performance.now() - checkStart),
                    });
                    if (!passed) failCount++;
                } catch {
                    results.push({
                        name,
                        status: 'fail',
                        latency_ms: Math.round(performance.now() - checkStart),
                    });
                    failCount++;
                }
            }

            const body: HealthStatus = {
                status: failCount === 0 ? 'healthy' : failCount < checks.length ? 'degraded' : 'unhealthy',
                version,
                uptime: (Date.now() - startTime) / 1000,
                checks: results,
                timestamp: new Date().toISOString(),
            };

            return { status: failCount === 0 ? 200 : 503, body };
        },
    };
}

export type HealthChecks = ReturnType<typeof createHealthChecks>;
