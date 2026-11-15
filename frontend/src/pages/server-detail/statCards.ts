/**
 * The four stat cards above the charts (ServerDetail.dc.html): the current
 * value (live from the SSE `servers` event via ServerSummary.latest), the
 * range's min/avg/max chips, and a badge when a threshold is crossed.
 */
import type { SeriesField, SeriesResponse, ServerStatus, ServerSummary } from '../../api/types';
import { formatCompact } from '../../lib/format';
import { formatThreshold } from '../../lib/status';
import { thresholdSeverity } from '../../lib/thresholds';

import { formatValue, statChips, type RateUnit, type StatChips, type ValueKind } from './chartData';

export type StatCardKey = 'cpu' | 'mem' | 'disk' | 'net_in';

export interface StatCardModel {
  key: StatCardKey;
  label: string;
  /** Mobile caption: "Net in". */
  shortLabel: string;
  value: string;
  unit: string;
  stats: StatChips | null;
  alert: { status: Extract<ServerStatus, 'warning' | 'critical'>; text: string } | null;
  /** One-line summary for the 390 px card. */
  footnote: string;
}

const CARDS: readonly { key: StatCardKey; label: string; shortLabel: string; kind: ValueKind }[] = [
  { key: 'cpu', label: 'CPU', shortLabel: 'CPU', kind: 'percent' },
  { key: 'mem', label: 'Memory', shortLabel: 'Memory', kind: 'percent' },
  { key: 'disk', label: 'Disk /', shortLabel: 'Disk /', kind: 'percent' },
  { key: 'net_in', label: 'Network in', shortLabel: 'Net in', kind: 'rate' },
];

const SEVERITY_SHORT = { critical: 'crit', warning: 'warn' } as const;

function thresholdText(value: number, kind: ValueKind, rate: RateUnit): string {
  return kind === 'percent' ? formatThreshold(value, '%') : `${formatCompact(value / rate.divisor)} ${rate.label}`;
}

export function buildStatCards(
  server: Pick<ServerSummary, 'latest' | 'thresholds'>,
  stats: SeriesResponse['stats'] | undefined,
  rate: RateUnit,
): StatCardModel[] {
  return CARDS.map(({ key, label, shortLabel, kind }) => {
    const field: SeriesField = key;
    const stat = stats?.[field];
    // An agent that never reports network sends zeros in `latest`; show it as unknown, like the chart.
    const unreported = kind === 'rate' && stats !== undefined && stat === undefined;
    const live = unreported ? null : (server.latest?.[field] ?? stat?.now ?? null);
    const chips = statChips(stat, kind, rate);
    const pair = server.thresholds[field];
    const severity = thresholdSeverity(live, pair);
    const line = severity === 'critical' ? pair?.critical : severity === 'warning' ? pair?.warning : null;
    const alert = severity && typeof line === 'number' ? { status: severity, text: `> ${thresholdText(line, kind, rate)}` } : null;

    let footnote = '';
    if (kind === 'rate') {
      const out = unreported ? null : (server.latest?.net_out ?? stats?.net_out?.now ?? null);
      footnote = `${rate.label} · out ${formatValue(out, 'rate', rate)}`;
    } else if (alert && severity) {
      footnote = `${SEVERITY_SHORT[severity]} ${alert.text}`;
    } else if (chips) {
      footnote = `avg ${chips.avg} · max ${chips.max}`;
    }

    return {
      key,
      label,
      shortLabel,
      value: formatValue(live, kind, rate),
      unit: kind === 'percent' ? '%' : rate.label,
      stats: chips,
      alert,
      footnote,
    };
  });
}
