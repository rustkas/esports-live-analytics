/**
 * Time Utilities
 * 
 * Functions for handling timestamps, clock skew, and time conversions.
 */

export const TIME_CONSTANTS = {
    MAX_CLOCK_SKEW_MS: 5000, // Allow 5s future skew
    MAX_LATENESS_MS: 2000,   // Max lag for late event handling (reordering) - used in sequence
};

/**
 * Check if event timestamp is significantly in the future (clock skew from source)
 */
export function isClockSkewed(tsEvent: string, toleranceMs = TIME_CONSTANTS.MAX_CLOCK_SKEW_MS): boolean {
    const eventTime = new Date(tsEvent).getTime();
    const now = Date.now();
    return eventTime > now + toleranceMs;
}

/**
 * Get current ISO timestamp
 */
export function nowISO(): string {
    return new Date().toISOString();
}

/**
 * Sleep for ms
 */
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
