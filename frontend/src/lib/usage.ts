/**
 * Plan usage maths (PLAN.md 3.4). Every plan limit uses 0 for unlimited, so a
 * limit of 0 never reads as "full".
 */

/** From this share of the limit the meter turns warn ("nearly full"). */
export const USAGE_NEAR_RATIO = 0.8;
export const UNLIMITED = 0;

export type UsageTone = 'normal' | 'near' | 'full';

export interface UsageState {
  used: number;
  /** The plan limit, or null when unlimited. */
  limit: number | null;
  /** 0 to 1, clamped; 0 when unlimited. */
  ratio: number;
  /** Rounded percent of the limit for the bar width, 0 to 100. */
  percent: number;
  tone: UsageTone;
  /** Slots left, or null when unlimited. Never negative. */
  remaining: number | null;
  atLimit: boolean;
  /** "3 of 10", or "3 · no limit". */
  label: string;
}

const PERCENT = 100;

const sanitize = (value: number): number => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

export function isUnlimited(limit: number): boolean {
  return !Number.isFinite(limit) || limit <= UNLIMITED;
}

export function usageLabel(used: number, limit: number): string {
  const count = sanitize(used);
  return isUnlimited(limit) ? `${count} · no limit` : `${count} of ${sanitize(limit)}`;
}

export function usageState(used: number, limit: number): UsageState {
  const count = sanitize(used);
  if (isUnlimited(limit)) {
    return { used: count, limit: null, ratio: 0, percent: 0, tone: 'normal', remaining: null, atLimit: false, label: usageLabel(count, limit) };
  }
  const max = sanitize(limit);
  const ratio = Math.min(1, count / max);
  const atLimit = count >= max;
  const tone: UsageTone = atLimit ? 'full' : ratio >= USAGE_NEAR_RATIO ? 'near' : 'normal';
  return {
    used: count,
    limit: max,
    ratio,
    percent: Math.round(ratio * PERCENT),
    tone,
    remaining: Math.max(0, max - count),
    atLimit,
    label: usageLabel(count, max),
  };
}
