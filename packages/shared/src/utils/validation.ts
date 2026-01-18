/**
 * Prediction Validation Utilities
 */

export const PREDICTOR_CONSTANTS = {
    MIN_PROB: 0.01,
    MAX_PROB: 0.99,
    MAX_SWING_PER_SEC: 0.20, // Max 20% jump per second allowed normally
};

export function clampProbability(p: number): number {
    if (isNaN(p)) return 0.5;
    return Math.max(PREDICTOR_CONSTANTS.MIN_PROB, Math.min(PREDICTOR_CONSTANTS.MAX_PROB, p));
}

export function isAnomalousJump(oldP: number, newP: number, timeDiffSec: number): boolean {
    if (timeDiffSec <= 0) return false;
    const diff = Math.abs(newP - oldP);
    const maxAllowed = PREDICTOR_CONSTANTS.MAX_SWING_PER_SEC * timeDiffSec + 0.05; // Base forgiveness
    return diff > maxAllowed;
}

export function validateProbability(p: number, fallback: number = 0.5): number {
    if (typeof p !== 'number' || isNaN(p) || !isFinite(p)) {
        return fallback;
    }
    return clampProbability(p);
}
