import { createClient } from '@clickhouse/client';
import fs from 'node:fs/promises';

const inFile = process.argv[2];
if (!inFile) {
    console.error('Usage: bun scripts/import-match.ts <file.jsonl>');
    process.exit(1);
}

const client = createClient({
    host: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
    database: process.env.CLICKHOUSE_DB || 'default',
});

console.log(`Reading ${inFile}...`);

try {
    const content = await fs.readFile(inFile, 'utf-8');
    const lines = content.trim().split('\n');
    const events = lines.map(line => JSON.parse(line));

    console.log(`Importing ${events.length} events to ClickHouse...`);

    // Clean up payloads if they are already strings or objects
    // The CH client expects objects for JSONEachRow

    await client.insert({
        table: 'cs2_events_raw',
        values: events,
        format: 'JSONEachRow',
    });

    console.log('Import done.');
} catch (e) {
    console.error('Import failed:', e);
} finally {
    await client.close();
}
