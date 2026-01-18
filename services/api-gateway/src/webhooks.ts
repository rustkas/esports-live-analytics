/**
 * Webhook Delivery Service
 * Delivers real-time events to partner webhooks.
 */

import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { createHmac } from 'node:crypto';
import { createLogger } from '@esports/shared';
import { config } from './config';

const logger = createLogger('api-gateway:webhooks');

export interface WebhookPayload {
    id: string;
    event: string;
    timestamp: string;
    data: any;
}

export function createWebhookService(redis: Redis, db: Pool) {
    const subRedis = redis.duplicate();

    async function start() {
        // Subscribe to prediction updates
        await subRedis.subscribe('prediction-updates');

        // Subscribe to match events
        await subRedis.psubscribe('prediction:updates:*');
        await subRedis.psubscribe('match:events:*');

        subRedis.on('pmessage', async (pattern, channel, message) => {
            try {
                const payload = JSON.parse(message);
                await distributeWebhook(payload, channel);
            } catch (err) {
                logger.error('Failed to process webhook event', { error: String(err) });
            }
        });

        // Handle standard message too if strict subscribe used
        subRedis.on('message', async (channel, message) => {
            try {
                const payload = JSON.parse(message);
                await distributeWebhook(payload, channel);
            } catch (err) { }
        });

        logger.info('Webhook service started');
    }

    async function distributeWebhook(payload: any, source: string) {
        // 1. Get active clients with webhook_url
        const clientsResult = await db.query(
            "SELECT id, webhook_url, name FROM api_clients WHERE is_active = true AND webhook_url IS NOT NULL"
        );

        const tasks = clientsResult.rows.map(async (client) => {
            try {
                // Use client ID as secret for demo if no dedicated secret column
                const secret = client.id;
                await sendWebhook(client.webhook_url, payload, client.id, secret);
            } catch (err) {
                logger.error('Webhook delivery failed permanently', {
                    client: client.name,
                    error: String(err)
                });
            }
        });

        await Promise.allSettled(tasks);
    }

    async function sendWebhook(url: string, payload: any, clientId: string, secret: string) {
        const controller = new AbortController();
        const body = JSON.stringify(payload);

        // HMAC Signature
        const signature = createHmac('sha256', secret).update(body).digest('hex');

        const maxRetries = 3;
        let attempt = 0;
        let lastError: any;

        while (attempt < maxRetries) {
            try {
                const timeout = setTimeout(() => controller.abort(), 5000);
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Esports-Event-ID': crypto.randomUUID(),
                        'X-Esports-Signature': `sha256=${signature}`,
                        'User-Agent': 'Esports-Analytics-Bot/1.0',
                    },
                    body,
                    signal: controller.signal,
                });
                clearTimeout(timeout);

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                return; // Success

            } catch (error) {
                lastError = error;
                attempt++;
                // Exponential backoff
                if (attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
                }
            }
        }

        // Failed after retries -> DLQ
        logger.warn('Webhook moved to DLQ', { clientId, url });
        await redis.lpush(`webhook:dlq:${clientId}`, JSON.stringify({
            url,
            payload,
            error: String(lastError),
            timestamp: Date.now()
        }));
    }

    return { start };
}
