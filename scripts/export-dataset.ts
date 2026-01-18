/**
 * Dataset Exporter
 * Exports joined Events and Predictions for model training.
 * 
 * Usage: bun scripts/export-dataset.ts
 */

import { createClient } from '@clickhouse/client';
import fs from 'fs';

const clickhouse = createClient({
    host: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
    database: 'default',
});

async function exportDataset() {
    console.log('📦 Exporting dataset to dataset.jsonl...');

    // Select matches with results
    const query = `
        SELECT 
            p.match_id,
            p.map_id,
            p.round_no,
            p.ts_calc,
            p.p_team_a_win,
            p.features,
            e.winner_team as outcome
        FROM cs2_predictions p
        JOIN (
            SELECT match_id, winner_team 
            FROM cs2_events_parsed 
            WHERE type = 'match_end'
        ) e ON p.match_id = e.match_id
        LIMIT 10000
    `;

    const stream = await clickhouse.query({
        query,
        format: 'JSONEachRow',
    });

    const msgStream = stream.stream();
    const writeStream = fs.createWriteStream('dataset.jsonl');

    for await (const rows of msgStream) {
        // clickhouse client streaming yields chunks of rows
        // Note: verify if it yields rows or chunks. v0.2.x yields chunks?
        // Actually .json() returns all. .stream() requires manual parsing if format isn't handled?
        // ClickHouse client 'JSONEachRow' stream usually yields items if config specific?
        // Let's assume standard behavior: rows array processing. 
        // For simplicity in this script, getting all json is easier if dataset is small.
        // For production large export, we need proper stream handling.
        // Let's just do fetch-all for the skeleton.
    }

    // Re-impl with standard query for skeleton
    const result = await clickhouse.query({ query, format: 'JSONEachRow' });
    const data = await result.json<any[]>();

    for (const row of data) {
        writeStream.write(JSON.stringify(row) + '\n');
    }

    writeStream.end();
    console.log(`✅ Exported ${data.length} rows.`);
    await clickhouse.close();
}

exportDataset().catch(console.error);
