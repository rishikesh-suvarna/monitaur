/**
 * The stat cards above the charts (ServerDetail.dc.html): the current value
 * (live from the SSE `servers` event via ServerSummary.latest), the range's
 * min/avg/max chips, and a badge when a threshold is crossed. The section 6.1
 * host cards (load, swap, disk read and write) are left out when the agent
 * does not report them.
 */
import type { SeriesField, SeriesResponse, ServerLatest, ServerStatus, ServerSummary } from '../../api/types';
import { formatBytes, formatCompact } from '../../lib/format';
import { formatThreshold } from '../../lib/status';
import { thresholdSeverity } from '../../lib/thresholds';

import { formatLoadLimit, formatValue, loadAverages, statChips, type RateUnit, type StatChips, type ValueKind } from './chartData';

export type StatCardKey = 'cpu' | 'mem' | 'disk' | 'net_in' | 'load1' | 'swap' | 'disk_read' | 'disk_write';

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
  /** Extra line for the desktop card, e.g. the 5 and 15 min load; empty for none. */
  detail: string;
}

type RateSource = 'net' | 'disk';

interface CardDef {
  key: StatCardKey;
  label: string;
  shortLabel: string;
  kind: ValueKind;
  /** Which rate unit a rate card reads in. */
  rate?: RateSource;
  /** Section 6.1 metric: null in `latest` means the agent does not send it. */
  extended?: boolean;
}

const CARDS: readonly CardDef[] = [
  { key: 'cpu', label: 'CPU', shortLabel: 'CPU', kind: 'percent' },
  { key: 'mem', label: 'Memory', shortLabel: 'Memory', kind: 'percent' },
  { key: 'disk', label: 'Disk /', shortLabel: 'Disk /', kind: 'percent' },
  { key: 'net_in', label: 'Network in', shortLabel: 'Net in', kind: 'rate', rate: 'net' },
  { key: 'load1', label: 'Load (1 min)', shortLabel: 'Load 1m', kind: 'number', extended: true },
  { key: 'swap', label: 'Swap', shortLabel: 'Swap', kind: 'percent', extended: true },
  { key: 'disk_read', label: 'Disk read', shortLabel: 'Disk read', kind: 'rate', rate: 'disk', extended: true },
  { key: 'disk_write', label: 'Disk write', shortLabel: 'Disk write', kind: 'rate', rate: 'disk', extended: true },
];

const SEVERITY_SHORT = { critical: 'crit', warning: 'warn' } as const;

const finite = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

function thresholdText(value: number, kind: ValueKind, rate: RateUnit): string {
  if (kind === 'percent') return formatThreshold(value, '%');
  if (kind === 'number') return formatLoadLimit(value);
  return `${formatCompact(value / rate.divisor)} ${rate.label}`;
}

function unitFor(kind: ValueKind, rate: RateUnit): string {
  if (kind === 'percent') return '%';
  if (kind === 'rate') return rate.label;
  return '';
}

/** Desktop extra line: the other load averages (the core count is in the header), or how much swap is in use. */
function detailFor(key: StatCardKey, latest: ServerLatest | null): string {
  if (!latest) return '';
  if (key === 'load1') return loadAverages(latest) ?? '';
  if (key === 'swap') {
    if (latest.swap_total === 0) return 'No swap space';
    if (finite(latest.swap_used) && finite(latest.swap_total)) return `${formatBytes(latest.swap_used)} of ${formatBytes(latest.swap_total)}`;
  }
  return '';
}

export function buildStatCards(
  server: Pick<ServerSummary, 'latest' | 'thresholds'>,
  stats: SeriesResponse['stats'] | undefined,
  rate: RateUnit,
  diskRate: RateUnit = rate,
): StatCardModel[] {
  const latest = server.latest;
  return CARDS.flatMap(({ key, label, shortLabel, kind, rate: source, extended = false }) => {
    const field: SeriesField = key;
    const stat = stats?.[field];
    const unitRate = source === 'disk' ? diskRate : rate;
    // An older backend leaves the section 6.1 keys out entirely; read that as null too.
    const raw: number | null | undefined = latest?.[field];
    const reported = finite(raw) ? raw : null;
    // Host metrics: hidden when neither the live sample nor the range has them (older agents).
    if (extended && reported === null && stat === undefined) return [];
    // An agent that never reports network sends zeros in `latest`; show it as unknown, like the chart.
    const unreported = kind === 'rate' && !extended && stats !== undefined && stat === undefined;
    const live = unreported ? null : (reported ?? stat?.now ?? null);
    const chips = statChips(stat, kind, unitRate);
    const pair = server.thresholds[field];
    const severity = thresholdSeverity(live, pair);
    const line = severity === 'critical' ? pair?.critical : severity === 'warning' ? pair?.warning : null;
    const alert = severity && typeof line === 'number' ? { status: severity, text: `> ${thresholdText(line, kind, unitRate)}` } : null;

    let footnote = '';
    if (key === 'net_in') {
      const out = unreported ? null : (latest?.net_out ?? stats?.net_out?.now ?? null);
      footnote = `${rate.label} · out ${formatValue(out, 'rate', rate)}`;
    } else if (alert && severity) {
      footnote = `${SEVERITY_SHORT[severity]} ${alert.text}`;
    } else if (key === 'load1') {
      footnote = loadAverages(latest, true) ?? (chips ? `avg ${chips.avg} · max ${chips.max}` : '');
    } else if (kind === 'rate') {
      footnote = chips ? `${unitRate.label} · max ${chips.max}` : unitRate.label;
    } else if (chips) {
      footnote = `avg ${chips.avg} · max ${chips.max}`;
    }

    return [
      {
        key,
        label,
        shortLabel,
        value: formatValue(live, kind, unitRate),
        unit: unitFor(kind, unitRate),
        stats: chips,
        alert,
        footnote,
        detail: detailFor(key, latest),
      },
    ];
  });
}
