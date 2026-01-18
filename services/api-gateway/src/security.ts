/**
 * Security Integration
 * 
 * Initializes rate limiter, rate limiters, and auditing for API Gateway.
 */

import type Redis from 'ioredis';
import type { Pool } from 'pg';
import type { Context, Next } from 'hono';
import {
    createRateLimiter,
    createAuditLogger,
    validateApiKey,
    isIpAllowed,
    hasPermission,
    type ApiClient,
    type AuditEntry,
} from '@esports/shared';
import { createLogger } from '@esports/shared';

const logger = createLogger('api-gateway:security');

// ============================================
// Service Initialization
// ============================================

export function createSecurityService(redis: Redis, db: Pool) {
    // Rate Limiter
    const rateLimiter = createRateLimiter(redis);

    // Audit Logger
    const auditLogger = createAuditLogger(async (entries: AuditEntry[]) => {
        if (entries.length === 0) return;

        const query = `
      INSERT INTO api_audit_log (
        request_id, client_id, ip_address, user_agent, 
        method, path, resource, action, 
        status_code, latency_ms, metadata, timestamp
      ) VALUES 
      ${entries.map((_, i) => `(
        $${i * 12 + 1}, $${i * 12 + 2}, $${i * 12 + 3}, $${i * 12 + 4}, 
        $${i * 12 + 5}, $${i * 12 + 6}, $${i * 12 + 7}, $${i * 12 + 8}, 
        $${i * 12 + 9}, $${i * 12 + 10}, $${i * 12 + 11}, $${i * 12 + 12}
      )`).join(', ')}
    `;

        const values = entries.flatMap(e => [
            e.request_id,
            e.client_id,
            e.ip_address,
            e.user_agent,
            e.method || 'UNKNOWN',
            e.resource || '/',
            e.resource,
            e.action,
            e.status_code,
            e.latency_ms,
            JSON.stringify(e.metadata || {}),
            e.timestamp,
        ]);

        await db.query(query, values);
    });

    // Client Loader
    const getClientByKey = async (apiKey: string): Promise<ApiClient | null> => {
        // Check cache first
        const cacheKey = `security:client:${apiKey}`;
        const cached = await redis.get(cacheKey);

        if (cached) {
            return JSON.parse(cached) as ApiClient;
        }

        // Hash lookup in DB would be ideal if we store hashes, 
        // but validateApiKey helper assumes we have hash in DB.
        // Since we don't have a way to lookup by hash without scanning (unless we use hash as index),
        // we typically lookup by API Key ID or having a separate "lookup key" part of the API key.
        // For this implementation, we assume we can query by api_key directly (in insecure way) OR 
        // we iterate or better: store apiKey -> client mapping in Redis for fast lookup.

        // Simplification for prototype: query by api_key (assuming plain text in DB as per init.sql)
        // In real prod, we'd use hash lookup.

        const result = await db.query(
            `SELECT 
        id as client_id, 
        name as client_name, 
        api_key, 
        rate_limit_per_minute as rate_limit_per_min,
        scopes as permissions,
        webhook_url,
        is_active,
        created_at
       FROM api_clients 
       WHERE api_key = $1 AND is_active = true`,
            [apiKey]
        );

        if (result.rows.length === 0) return null;

        const row = result.rows[0];
        const client: ApiClient = {
            client_id: row.client_id,
            client_name: row.client_name,
            api_key_hash: '', // Not needed for this flow if querying directly
            rate_limit_per_min: row.rate_limit_per_min,
            permissions: row.permissions,
            webhook_url: row.webhook_url,
            is_active: true,
            created_at: row.created_at,
        };

        // Cache for 1 minute
        await redis.set(cacheKey, JSON.stringify(client), 'EX', 60);

        return client;
    };

    return { rateLimiter, auditLogger, getClientByKey };
}

// ============================================
// Middleware Factory
// ============================================

export function createAuthMiddleware(
    security: ReturnType<typeof createSecurityService>,
    requiredPermission?: string
) {
    return async (c: Context, next: Next) => {
        const start = performance.now();
        const requestId = crypto.randomUUID();

        // 1. Extract API Key
        const authHeader = c.req.header('Authorization');
        const apiKey = authHeader?.replace('Bearer ', '');

        if (!apiKey) {
            return c.json({ error: 'Missing API Key' }, 401);
        }

        // 2. Authenticate Client
        const client = await security.getClientByKey(apiKey);

        if (!client) {
            return c.json({ error: 'Invalid API Key' }, 401);
        }

        // 3. Check Permissions
        if (requiredPermission && !hasPermission(client, requiredPermission)) {
            return c.json({ error: 'Permission Denied' }, 403);
        }

        // 4. Rate Limit
        const limitParams = await security.rateLimiter.check(
            client.client_id,
            client.rate_limit_per_min
        );

        c.header('X-RateLimit-Limit', String(client.rate_limit_per_min));
        c.header('X-RateLimit-Remaining', String(limitParams.remaining));
        c.header('X-RateLimit-Reset', String(Math.ceil(limitParams.resetAt / 1000)));

        if (!limitParams.allowed) {
            return c.json({ error: 'Rate Limit Exceeded' }, 429);
        }

        await security.rateLimiter.increment(client.client_id);

        // 5. Attach Client to Context
        c.set('client', client);
        c.set('requestId', requestId);

        // Proceed
        await next();

        // 6. Audit Logging (Async)
        const latency = performance.now() - start;
        security.auditLogger.log({
            client_id: client.client_id,
            ip_address: c.req.header('CF-Connecting-IP') ?? 'unknown',
            user_agent: c.req.header('User-Agent'),
            method: c.req.method,
            resource: c.req.path, // Simplification
            action: `${c.req.method}:${c.req.path}`,
            status_code: c.res.status,
            latency_ms: Math.round(latency),
            metadata: {},
        });
    };
}
