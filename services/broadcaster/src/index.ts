import { WebSocketServer, WebSocket } from 'ws';
import Redis from 'ioredis';
import { createLogger } from '@esports/shared';
import { config } from './config';

const logger = createLogger('broadcaster', config.logLevel as 'debug' | 'info');

const redisSub = new Redis(config.redis.url);
const subs = new Map<string, Set<WebSocket>>();

async function main() {
    const wss = new WebSocketServer({ port: config.port });

    logger.info(`Broadcaster started on port ${config.port}`);

    wss.on('connection', (ws, req) => {
        try {
            const url = new URL(req.url!, `http://localhost:${config.port}`);
            const matchId = url.searchParams.get('matchId');

            if (!matchId) {
                ws.close(1008, 'matchId required');
                return;
            }

            if (!subs.has(matchId)) {
                subs.set(matchId, new Set());
            }
            subs.get(matchId)!.add(ws);

            logger.debug('Client connected', { matchId, total_clients: wss.clients.size });

            ws.on('close', () => {
                const set = subs.get(matchId);
                if (set) {
                    set.delete(ws);
                    if (set.size === 0) subs.delete(matchId);
                }
            });

            ws.on('error', (err) => {
                logger.error('WS Error', { error: String(err) });
            });
        } catch (e) {
            logger.error('Connection error', { error: String(e) });
            ws.close();
        }
    });

    // Subscribe to match updates
    await redisSub.psubscribe('updates:match:*');
    await redisSub.psubscribe('updates:prediction:*');

    redisSub.on('pmessage', (pattern, channel, message) => {
        // Extract matchId. Channel format: updates:match:{id}
        const parts = channel.split(':');
        const matchId = parts[parts.length - 1]; // Last part

        const set = subs.get(matchId);
        if (set && set.size > 0) {
            for (const ws of set) {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(message); // Forward raw JSON
                }
            }
        }
    });
}

main().catch(err => {
    logger.error('Fatal error', { error: String(err) });
    process.exit(1);
});
