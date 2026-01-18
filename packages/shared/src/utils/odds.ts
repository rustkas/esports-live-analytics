/**
 * Betting Odds Utilities
 */

export interface Odds {
    decimal: number;
    american: number;
}

const MIN_PROB = 0.01;
const MAX_PROB = 0.99;

/**
 * Convert probability to implied decimal odds with optional margin.
 * @param probability 0.0 to 1.0 (will be clamped to 0.01-0.99)
 * @param margin decimal margin (e.g. 0.05 for 5%)
 */
export function probabilityToOdds(probability: number, margin: number = 0): number {
    const p = Math.max(MIN_PROB, Math.min(MAX_PROB, probability));
    const fairOdds = 1 / p;
    // Apply margin: reduce odds. 
    // Standard notation: P_book = P_fair * (1 + margin). Odds_book = 1 / P_book.
    const pBook = p * (1 + margin);
    return Number((1 / pBook).toFixed(3));
}

/**
 * Calculate American odds from Decimal
 */
export function decimalToAmerican(decimal: number): number {
    if (decimal >= 2.0) {
        return Math.round((decimal - 1) * 100);
    } else {
        return Math.round(-100 / (decimal - 1));
    }
}

/**
 * Format full odds object
 */
export function formatOdds(probability: number, margin: number = 0.06): Odds {
    const decimal = probabilityToOdds(probability, margin);
    return {
        decimal,
        american: decimalToAmerican(decimal)
    };
}
