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
    const getClientByKey = async (rawApiKey: string): Promise<ApiClient | null> => {
        // Check cache first
        const cacheKey = `security:client:${rawApiKey}`;
        const cached = await redis.get(cacheKey);

        if (cached) {
            return JSON.parse(cached) as ApiClient;
        }

        // Parse Key: prefix.secret
        const parts = rawApiKey.split('.');
        // Support legacy plain keys for transition if needed, but per request we strict
        if (parts.length !== 2) {
            // Fallback to legacy check if legacy_api_key exists in api_clients
            // For now, fail invalid format
            return null;
        }
        const [prefix, secret] = parts;

        // 1. Lookup Key by Prefix
        const keyResult = await db.query(
            `SELECT client_id, key_hash, scopes FROM api_keys WHERE key_prefix = $1 AND is_active = true`,
            [prefix]
        );

        if (keyResult.rows.length === 0) return null;
        const keyRow = keyResult.rows[0];

        // 2. Verify Hash (SHA-256)
        // Note: In prod, use scrypt/argon2, but SHA256 is fast for API keys if high entropy
        const crypto = await import('node:crypto');
        const hash = crypto.createHash('sha256').update(secret).digest('hex');

        if (hash !== keyRow.key_hash) return null;

        // 3. Update Last Used (Async - fire and forget)
        db.query('UPDATE api_keys SET last_used_at = NOW() WHERE key_prefix = $1', [prefix]).catch(err =>
            logger.error('Failed to update key usage', { error: String(err) })
        );

        // 4. Get Client Details
        const clientResult = await db.query(
            `SELECT 
                id as client_id, 
                name as client_name, 
                rate_limit_per_minute as rate_limit_per_min,
                quota_limit_monthly,
                quota_used_monthly,
                webhook_url,
                is_active,
                created_at
            FROM api_clients 
            WHERE id = $1 AND is_active = true`,
            [keyRow.client_id]
        );

        if (clientResult.rows.length === 0) return null;
        const clientRow = clientResult.rows[0];

        // 5. Check Quota
        if (clientRow.quota_limit_monthly > 0 && clientRow.quota_used_monthly >= clientRow.quota_limit_monthly) {
            logger.warn('Quota exceeded', { client_id: clientRow.client_id });
            return null; // Handle as 403 in middleware/return specific indicator
        }
        // Increment quota usage in background or Redis
        // Here we just check limit. Incrementing usually implies Redis counter flushed to DB.

        const client: ApiClient = {
            client_id: clientRow.client_id,
            client_name: clientRow.client_name,
            api_key_hash: keyRow.key_hash,
            rate_limit_per_min: clientRow.rate_limit_per_min,
            permissions: keyRow.scopes || [],
            webhook_url: clientRow.webhook_url,
            is_active: true,
            created_at: clientRow.created_at,
        };

        // Cache for 60s
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
