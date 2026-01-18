/**
 * Model Evaluation Script
 * Calculates Brier Score and Calibration metrics for historical predictions.
 * 
 * Usage: bun scripts/evaluate-model.ts
 */

import { createClient } from '@clickhouse/client';

const clickhouse = createClient({
    host: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
    database: 'default',
    username: 'default',
    password: '',
});

async function evaluate() {
    console.log('📊 Starting Model Evaluation...');

    // 1. Get finished matches and their winners
    const matchesResult = await clickhouse.query({
        query: `
            SELECT 
                match_id, 
                winner_team 
            FROM cs2_events_parsed 
            WHERE type = 'match_end' AND winner_team != ''
            LIMIT 100
        `,
        format: 'JSONEachRow'
    });
    const matches = await matchesResult.json<{ match_id: string, winner_team: string }[]>();

    if (matches.length === 0) {
        console.log('No finished matches found for evaluation.');
        return;
    }

    console.log(`Found ${matches.length} finished matches.`);

    let totalBrierScore = 0;
    let count = 0;

    // Calibration bins (0-0.1, 0.1-0.2, ...)
    const bins = new Array(10).fill(0).map(() => ({ sumProb: 0, count: 0, wins: 0 }));

    for (const match of matches) {
        const winner = match.winner_team; // 'A' or 'B'
        const winnerVal = winner === 'A' ? 1 : 0;

        // Get predictions for this match
        const predsResult = await clickhouse.query({
            query: `
                SELECT p_team_a_win 
                FROM cs2_predictions 
                WHERE match_id = {matchId: UUID}
            `,
            query_params: { matchId: match.match_id },
            format: 'JSONEachRow'
        });
        const preds = await predsResult.json<{ p_team_a_win: number }[]>();

        for (const p of preds) {
            const prob = p.p_team_a_win;

            // Brier Score: (prob - outcome)^2
            totalBrierScore += Math.pow(prob - winnerVal, 2);
            count++;

            // Calibration
            const binIdx = Math.min(Math.floor(prob * 10), 9);
            bins[binIdx].sumProb += prob;
            bins[binIdx].count++;
            if (winnerVal === 1) bins[binIdx].wins++;
        }
    }

    if (count === 0) {
        console.log('No predictions found for finished matches.');
        return;
    }

    const brierScore = totalBrierScore / count;
    console.log(`\n🏆 Model Evaluation Results`);
    console.log(`-------------------------`);
    console.log(`Brier Score: ${brierScore.toFixed(4)} (Lower is better)`);
    console.log(`Total Predictions: ${count}`);

    console.log(`\nCalibration Curve:`);
    console.log(`Bin range | Avg Prob | Actual Win Rate | Count`);
    bins.forEach((bin, i) => {
        if (bin.count > 0) {
            const avgProb = bin.sumProb / bin.count;
            const actualWinRate = bin.wins / bin.count;
            console.log(`${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}   | ${avgProb.toFixed(3)}    | ${actualWinRate.toFixed(3)}           | ${bin.count}`);
        }
    });

    await clickhouse.close();
}

evaluate().catch(console.error);
