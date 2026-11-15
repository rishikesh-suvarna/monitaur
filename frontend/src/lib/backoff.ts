export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
export const BACKOFF_JITTER = 0.2;

/**
 * Exponential backoff with +/- 20% jitter for reconnects: about 1 s, 2 s,
 * 4 s, ... capped at 30 s. `attempt` counts failures, starting at 1.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  const jitter = 1 + (random() * 2 - 1) * BACKOFF_JITTER;
  return Math.round(exponential * jitter);
}
