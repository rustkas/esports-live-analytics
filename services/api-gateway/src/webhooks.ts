/**
 * Webhook Delivery Service
 * Delivers real-time events to partner webhooks.
 */

import type Redis from 'ioredis';
import type { Pool } from 'pg';
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

        // Subscribe to match events (via pattern?)
        // Assuming we have a channel 'match-events' or similar. 
        // Prediction service publishes to `prediction:updates:{matchId}`.
        // We might need psubscribe `prediction:updates:*`.
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

        logger.info('Webhook service started');
    }

    async function distributeWebhook(payload: any, source: string) {
        // 1. Get active clients with webhook_url
        // Optimization: Cache this mapping or update on changes
        const clientsResult = await db.query(
            "SELECT id, webhook_url, name FROM api_clients WHERE is_active = true AND webhook_url IS NOT NULL"
        );

        const tasks = clientsResult.rows.map(async (client) => {
            try {
                // TODO: Filtering based on client subscriptions/ABAC

                await sendWebhook(client.webhook_url, payload, client.id);
            } catch (err) {
                logger.error('Webhook delivery failed', {
                    client: client.name,
                    error: String(err)
                });
            }
        });

        await Promise.allSettled(tasks);
    }

    async function sendWebhook(url: string, payload: any, clientId: string) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Esports-Event-ID': crypto.randomUUID(),
                    'User-Agent': 'Esports-Analytics-Bot/1.0',
                    // TODO: Add HMAC signature
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });

            clearTimeout(timeout);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            // Log successful delivery? (Too noisy for every event)
        } catch (error) {
            clearTimeout(timeout);
            throw error;
        }
    }

    return { start };
}
