/**
 * Uptime check vocabulary (docs/platform-v2.md 6.3) mapped onto the design's
 * status encoding: every check status reuses a StatusBadge shape with its own
 * word, so "Down" reads as critical without inventing a fifth shape.
 */
import type { Check, CheckMetric, CheckStatus, CheckType, IncidentMetric, ServerStatus } from '../api/types';

import { EMPTY_VALUE } from './format';

export interface CheckStatusMeta {
  /** The StatusBadge shape and colour. */
  status: ServerStatus;
  /** The word shown with it. */
  label: string;
  /** Sort rank, worst first (down, degraded, pending, paused, up). */
  rank: number;
}

export const CHECK_STATUS_META: Record<CheckStatus, CheckStatusMeta> = {
  down: { status: 'critical', label: 'Down', rank: 0 },
  degraded: { status: 'warning', label: 'Degraded', rank: 1 },
  pending: { status: 'offline', label: 'Pending', rank: 2 },
  paused: { status: 'offline', label: 'Paused', rank: 3 },
  up: { status: 'healthy', label: 'Up', rank: 4 },
};

export const CHECK_STATUSES: readonly CheckStatus[] = ['down', 'degraded', 'pending', 'paused', 'up'];

/** up to healthy, down to critical, degraded to warning, paused and pending to offline. */
export function checkBadgeStatus(status: CheckStatus): ServerStatus {
  return CHECK_STATUS_META[status].status;
}

export const isCheckStatus = (value: string): value is CheckStatus => (CHECK_STATUSES as readonly string[]).includes(value);

export function compareCheckStatus(a: CheckStatus, b: CheckStatus): number {
  return CHECK_STATUS_META[a].rank - CHECK_STATUS_META[b].rank;
}

/** Worst first, then by name. */
export function sortChecks(checks: readonly Check[]): Check[] {
  return [...checks].sort((a, b) => compareCheckStatus(a.status, b.status) || a.name.localeCompare(b.name) || a.id - b.id);
}

export type CheckStatusCounts = Record<CheckStatus, number> & { all: number };

export function countChecksByStatus(checks: readonly Check[]): CheckStatusCounts {
  const counts: CheckStatusCounts = { all: checks.length, down: 0, degraded: 0, pending: 0, paused: 0, up: 0 };
  for (const check of checks) counts[check.status] += 1;
  return counts;
}

export const CHECK_TYPES: readonly CheckType[] = ['http', 'tcp', 'tls'];

export const CHECK_TYPE_LABELS: Record<CheckType, string> = { http: 'HTTP', tcp: 'TCP', tls: 'TLS' };

const CHECK_METRICS: readonly CheckMetric[] = ['http', 'tcp', 'tls', 'tls_expiry'];

export const isCheckMetric = (metric: IncidentMetric): metric is CheckMetric => (CHECK_METRICS as readonly string[]).includes(metric);

export const CHECK_METRIC_LABELS: Record<CheckMetric, string> = {
  http: 'HTTP check',
  tcp: 'TCP check',
  tls: 'TLS handshake',
  tls_expiry: 'Certificate',
};

export const checkPath = (checkId: number): string => `/checks/${checkId}`;

// ---------------------------------------------------------------- values

const MS_PER_SECOND = 1000;
const LATENCY_SECONDS_FROM_MS = 1000;
const LATENCY_SECOND_DECIMALS = 2;
const LATENCY_MIN_SCALE_MS = 100;
const LATENCY_HEADROOM = 1.2;

/** "212 ms", "1.24 s". */
export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return EMPTY_VALUE;
  if (ms < LATENCY_SECONDS_FROM_MS) return `${Math.round(ms)} ms`;
  return `${(ms / MS_PER_SECOND).toFixed(LATENCY_SECOND_DECIMALS)} s`;
}

/** Latency as a number and a unit, for big readouts: { value: '212', unit: 'ms' }. */
export function latencyParts(ms: number | null | undefined): { value: string; unit: string | undefined } {
  const text = formatLatency(ms);
  const space = text.lastIndexOf(' ');
  return space === -1 ? { value: text, unit: undefined } : { value: text.slice(0, space), unit: text.slice(space + 1) };
}

export type TlsTone = 'ok' | 'warn' | 'crit' | 'none';

/** Certificate days left against the check's warning window. */
export function tlsTone(daysLeft: number | null, warnDays: number): TlsTone {
  if (daysLeft === null || !Number.isFinite(daysLeft)) return 'none';
  if (daysLeft <= 0) return 'crit';
  if (daysLeft <= warnDays) return 'warn';
  return 'ok';
}

/** "41 d", "expired", or EMPTY_VALUE when unknown. */
export function formatTlsDays(daysLeft: number | null): string {
  if (daysLeft === null || !Number.isFinite(daysLeft)) return EMPTY_VALUE;
  if (daysLeft <= 0) return 'expired';
  return `${Math.floor(daysLeft)} d`;
}

/** Whether the type reports certificate expiry: tls always, http only over https. */
export function reportsTls(check: Pick<Check, 'type' | 'target'>): boolean {
  return check.type === 'tls' || (check.type === 'http' && /^https:/i.test(check.target.trim()));
}

/** The latency sparkline's top: 20% headroom over the slowest point, at least 100 ms. */
export function latencyScaleMax(values: readonly number[]): number {
  const peak = values.reduce((max, value) => (Number.isFinite(value) && value > max ? value : max), 0);
  return Math.max(LATENCY_MIN_SCALE_MS, Math.ceil(peak * LATENCY_HEADROOM));
}

/** "HTTP 200 · 212 ms", "connection refused · 3.00 s": one line for a check result. */
export function describeResult(result: { ok: boolean; latency_ms: number; status_code: number | null; error: string | null }): string {
  const parts: string[] = [];
  if (result.status_code !== null) parts.push(`HTTP ${result.status_code}`);
  if (!result.ok && result.error) parts.push(result.error);
  parts.push(formatLatency(result.latency_ms));
  return parts.join(' · ');
}
