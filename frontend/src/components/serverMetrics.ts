import type { ServerSummary, Severity } from '../api/types';
import { EMPTY_VALUE, formatMBps } from '../lib/format';
import type { FleetMetric, MetricBreaches } from '../lib/status';
import { hasThreshold, thresholdSeverity } from '../lib/thresholds';

import type { SparkTone } from './Sparkline';

export interface MetricCell {
  key: FleetMetric;
  /** Short caption used in cards: CPU, Mem, Disk. */
  label: string;
  values: readonly number[];
  value: number | null;
  display: string;
  tone: SparkTone;
  /** Over a threshold right now (bold, coloured value). */
  over: boolean;
}

const METRICS: readonly { key: FleetMetric; label: string }[] = [
  { key: 'cpu', label: 'CPU' },
  { key: 'mem', label: 'Mem' },
  { key: 'disk', label: 'Disk' },
];

const toneForSeverity = (severity: Severity): SparkTone => (severity === 'critical' ? 'crit' : 'warn');

/** Is this server's data frozen (agent not reporting)? Drawn at 55% with dashed lines. */
export const isStale = (server: ServerSummary): boolean => server.status === 'offline';

/**
 * How far over its rules a metric is right now. The server's own thresholds
 * (ServerSummary.thresholds) decide when the metric has one; otherwise an
 * active incident on that metric is the fallback.
 */
export function metricSeverity(
  server: Pick<ServerSummary, 'thresholds' | 'latest'>,
  key: FleetMetric,
  breaches: MetricBreaches | undefined,
): Severity | undefined {
  const pair = server.thresholds[key];
  if (hasThreshold(pair)) return thresholdSeverity(server.latest?.[key], pair) ?? undefined;
  return breaches?.[key];
}

/** The three overview metric cells for a server, toned by its thresholds (or, without one, its active incidents). */
export function metricCells(server: ServerSummary, breaches: MetricBreaches | undefined): MetricCell[] {
  const stale = isStale(server);
  return METRICS.map(({ key, label }) => {
    const value = server.latest?.[key] ?? null;
    const severity = metricSeverity(server, key, breaches);
    const over = severity !== undefined && !stale;
    return {
      key,
      label,
      values: server.spark[key],
      value,
      display: value === null ? EMPTY_VALUE : `${Math.round(value)}%`,
      tone: stale ? 'off' : severity ? toneForSeverity(severity) : 'series',
      over,
    };
  });
}

export const VALUE_TONE_CLASS: Record<SparkTone, string> = {
  series: 'text-ink',
  'series-2': 'text-ink',
  warn: 'text-warn',
  crit: 'text-crit',
  off: 'text-ink',
};

/** Stretched link: the whole row is clickable, the name is the real link. */
export const STRETCHED_LINK =
  'no-underline after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:rounded-sm ' +
  'focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent';

export const serverPath = (serverId: number): string => `/servers/${serverId}`;

/** Total throughput for the "Net MB/s" column: in + out. */
export function netThroughput(server: ServerSummary): string {
  if (isStale(server) || !server.latest) return EMPTY_VALUE;
  return formatMBps(server.latest.net_in + server.latest.net_out);
}

