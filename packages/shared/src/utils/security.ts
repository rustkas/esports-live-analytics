/**
 * B2B Security Middleware
 * 
 * API Key authentication, rate limiting, and audit logging.
 */

import type { Redis } from 'ioredis';
import { createLogger } from './logger';

const logger = createLogger('security', 'info');

// ============================================
// Types
// ============================================

export interface ApiClient {
    client_id: string;
    client_name: string;
    api_key_hash: string;        // bcrypt hash
    rate_limit_per_min: number;
    allowed_ips?: string[];
    permissions: string[];       // ['read:matches', 'read:predictions', 'write:events']
    webhook_url?: string;
    webhook_secret?: string;     // for HMAC signatures
    is_active: boolean;
    created_at: string;
}

export interface AuthResult {
    success: boolean;
    client?: ApiClient;
    error?: string;
    error_code?: 'INVALID_KEY' | 'RATE_LIMITED' | 'IP_BLOCKED' | 'PERMISSION_DENIED' | 'INACTIVE';
}

export interface AuditEntry {
    timestamp: string;
    client_id: string;
    action: string;
    method: string;
    resource: string;
    ip_address: string;
    user_agent?: string;
    status_code: number;
    latency_ms: number;
    request_id: string;
    metadata?: Record<string, unknown>;
}

// ============================================
// API Key Utilities
// ============================================

/**
 * Generate a new API key
 * Format: esports_live_{random_32_chars}
 */
export function generateApiKey(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let key = 'esports_live_';
    for (let i = 0; i < 32; i++) {
        key += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return key;
}

/**
 * Hash API key for storage
 * Uses SHA-256 for fast validation (bcrypt would be too slow for every request)
 */
export async function hashApiKey(key: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(key);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate API key against hash
 */
export async function validateApiKey(key: string, hash: string): Promise<boolean> {
    const keyHash = await hashApiKey(key);
    return keyHash === hash;
}

// ============================================
// Rate Limiter (Sliding Window)
// ============================================

export interface RateLimiter {
    check(clientId: string, limit: number): Promise<{ allowed: boolean; remaining: number; resetAt: number }>;
    increment(clientId: string): Promise<void>;
}

export function createRateLimiter(redis: Redis, windowMs = 60000): RateLimiter {
    const keyPrefix = 'ratelimit:';

    return {
        async check(clientId: string, limit: number) {
            const now = Date.now();
            const windowStart = now - windowMs;
            const key = `${keyPrefix}${clientId}`;

            // Remove old entries
            await redis.zremrangebyscore(key, 0, windowStart);

            // Count current requests
            const count = await redis.zcard(key);

            return {
                allowed: count < limit,
                remaining: Math.max(0, limit - count),
                resetAt: now + windowMs,
            };
        },

        async increment(clientId: string) {
            const now = Date.now();
            const key = `${keyPrefix}${clientId}`;

            // Add current request
            await redis.zadd(key, String(now), `${now}-${Math.random()}`);

            // Set expiry
            await redis.expire(key, Math.ceil(windowMs / 1000) + 1);
        },
    };
}

// ============================================
// IP Allowlist Check
// ============================================

export function isIpAllowed(clientIp: string, allowedIps?: string[]): boolean {
    if (!allowedIps || allowedIps.length === 0) {
        return true; // No restrictions
    }

    return allowedIps.some(allowed => {
        // Exact match
        if (allowed === clientIp) return true;

        // CIDR match (simplified - /24 only)
        if (allowed.includes('/')) {
            const [network, mask] = allowed.split('/');
            if (mask === '24') {
                const clientPrefix = clientIp.split('.').slice(0, 3).join('.');
                const networkPrefix = network!.split('.').slice(0, 3).join('.');
                return clientPrefix === networkPrefix;
            }
        }

        return false;
    });
}

// ============================================
// Permission Check
// ============================================

export function hasPermission(client: ApiClient, requiredPermission: string): boolean {
    // Wildcard permission
    if (client.permissions.includes('*')) return true;

    // Exact match
    if (client.permissions.includes(requiredPermission)) return true;

    // Category wildcard (e.g., 'read:*' matches 'read:matches')
    const [action, resource] = requiredPermission.split(':');
    if (client.permissions.includes(`${action}:*`)) return true;

    return false;
}

// ============================================
// HMAC Webhook Signatures
// ============================================

export async function signWebhookPayload(
    payload: unknown,
    secret: string
): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );

    const data = encoder.encode(JSON.stringify(payload));
    const signature = await crypto.subtle.sign('HMAC', key, data);
    const signatureHex = Array.from(new Uint8Array(signature))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

    return `sha256=${signatureHex}`;
}

export async function verifyWebhookSignature(
    payload: unknown,
    signature: string,
    secret: string
): Promise<boolean> {
    const expected = await signWebhookPayload(payload, secret);

    // Constant-time comparison
    if (expected.length !== signature.length) return false;

    let result = 0;
    for (let i = 0; i < expected.length; i++) {
        result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    }

    return result === 0;
}

// ============================================
// Audit Logger
// ============================================

export interface AuditLogger {
    log(entry: Omit<AuditEntry, 'timestamp' | 'request_id'>): void;
    flush(): Promise<void>;
}

export function createAuditLogger(
    onFlush: (entries: AuditEntry[]) => Promise<void>,
    batchSize = 100,
    flushIntervalMs = 5000
): AuditLogger {
    const buffer: AuditEntry[] = [];
    let flushTimer: ReturnType<typeof setInterval> | null = null;

    const flush = async () => {
        if (buffer.length === 0) return;

        const entries = buffer.splice(0, buffer.length);
        try {
            await onFlush(entries);
        } catch (error) {
            logger.error('Audit log flush failed', { error: String(error), count: entries.length });
            // Re-add to buffer on failure
            buffer.unshift(...entries);
        }
    };

    // Start periodic flush
    flushTimer = setInterval(flush, flushIntervalMs);

    return {
        log(entry) {
            buffer.push({
                ...entry,
                timestamp: new Date().toISOString(),
                request_id: crypto.randomUUID(),
            });

            // Flush if batch size reached
            if (buffer.length >= batchSize) {
                flush();
            }
        },

        async flush() {
            if (flushTimer) {
                clearInterval(flushTimer);
            }
            await flush();
        },
    };
}
