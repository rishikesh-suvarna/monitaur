/**
 * Threshold helpers for ServerSummary.thresholds and the series response's
 * thresholds. Both come from enabled "above" rules, and the backend fires when
 * the value is strictly greater than the threshold (alerting.Rule.breached).
 */
import type { Severity, ThresholdPair } from '../api/types';

/** True when the pair has at least one usable threshold. */
export function hasThreshold(pair: ThresholdPair | null | undefined): pair is ThresholdPair {
  return pair !== null && pair !== undefined && (isFiniteValue(pair.warning) || isFiniteValue(pair.critical));
}

const isFiniteValue = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * The severity a value is in against its thresholds: critical over the
 * critical line, warning over the warning line, else null. Null for a missing
 * value or a missing pair.
 */
export function thresholdSeverity(value: number | null | undefined, pair: ThresholdPair | null | undefined): Severity | null {
  if (!isFiniteValue(value) || !pair) return null;
  if (isFiniteValue(pair.critical) && value > pair.critical) return 'critical';
  if (isFiniteValue(pair.warning) && value > pair.warning) return 'warning';
  return null;
}

export interface ThresholdLine {
  severity: Severity;
  value: number;
}

/** The pair as drawable lines, warning first. */
export function thresholdLines(pair: ThresholdPair | null | undefined): ThresholdLine[] {
  if (!pair) return [];
  const lines: ThresholdLine[] = [];
  if (isFiniteValue(pair.warning)) lines.push({ severity: 'warning', value: pair.warning });
  if (isFiniteValue(pair.critical)) lines.push({ severity: 'critical', value: pair.critical });
  return lines;
}
