import { createClient } from '@clickhouse/client';
import fs from 'node:fs/promises';

const matchId = process.argv[2];
const outFile = process.argv[3] || `match-${matchId}.jsonl`;

if (!matchId) {
    console.error('Usage: bun scripts/export-match.ts <matchId> [outFile]');
    process.exit(1);
}

const client = createClient({
    host: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
    database: process.env.CLICKHOUSE_DB || 'default',
});

console.log(`Exporting match ${matchId} to ${outFile}...`);

try {
    const rs = await client.query({
        query: `SELECT * FROM cs2_events_raw WHERE match_id = {m:String} ORDER BY seq_no ASC`,
        query_params: { m: matchId },
        format: 'JSONEachRow',
    });

    const rows = await rs.json<any[]>();

    if (rows.length === 0) {
        console.log('No events found.');
    } else {
        const content = rows.map(r => JSON.stringify(r)).join('\n');
        await fs.writeFile(outFile, content);
        console.log(`Exported ${rows.length} events.`);
    }
} catch (e) {
    console.error('Export failed:', e);
} finally {
    await client.close();
}
