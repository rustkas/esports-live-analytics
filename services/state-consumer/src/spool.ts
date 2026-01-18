/**
 * Local Disk Spool
 * Fallback storage when ClickHouse is unavailable.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BaseEvent } from '@esports/shared';
import { createLogger } from '@esports/shared';

const logger = createLogger('state-consumer:spool');

export class LocalDiskSpool {
    private spoolDir: string;

    constructor(dir = './data/spool') {
        this.spoolDir = dir;
        this.init();
    }

    private async init() {
        try {
            await fs.mkdir(this.spoolDir, { recursive: true });
        } catch (e) {
            logger.error('Failed to create spool dir', { error: String(e) });
        }
    }

    async write(events: BaseEvent[]): Promise<boolean> {
        try {
            const filename = `batch-${Date.now()}-${Math.random().toString(36).substring(7)}.json`;
            const filepath = path.join(this.spoolDir, filename);
            await fs.writeFile(filepath, JSON.stringify(events));
            logger.info('Spooled events to disk', { count: events.length, file: filename });
            return true;
        } catch (e) {
            logger.error('Failed to spool events', { error: String(e) });
            return false;
        }
    }

    async *readBatches(): AsyncGenerator<{ file: string, events: BaseEvent[] }> {
        let files: string[] = [];
        try {
            files = await fs.readdir(this.spoolDir);
        } catch {
            return;
        }

        for (const file of files) {
            if (!file.endsWith('.json')) continue;

            const filepath = path.join(this.spoolDir, file);
            try {
                const content = await fs.readFile(filepath, 'utf-8');
                const events = JSON.parse(content) as BaseEvent[];
                yield { file, events };
            } catch (e) {
                logger.error('Failed to read spool file', { file, error: String(e) });
                // Move to corrupt?
            }
        }
    }

    async delete(file: string) {
        try {
            await fs.unlink(path.join(this.spoolDir, file));
        } catch (e) {
            // ignore
        }
    }
}
