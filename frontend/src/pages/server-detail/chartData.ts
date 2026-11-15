/**
 * Shapes GET /servers/:id/series for the detail charts: rows for Recharts,
 * gaps (null points are breaks, never interpolated), the network unit, axis
 * scales, tick labels and the stat chips.
 */
import type {
  SeriesField,
  SeriesPoint,
  SeriesRange,
  SeriesResponse,
  SeriesStat,
  ServerLatest,
  Severity,
  ThresholdPair,
} from '../../api/types';
import { EMPTY_VALUE, formatBytes, formatCompact, toTime } from '../../lib/format';
import { formatThreshold } from '../../lib/status';
import { hasThreshold, thresholdLines } from '../../lib/thresholds';

export const SERIES_FIELDS: readonly SeriesField[] = ['cpu', 'mem', 'disk', 'net_in', 'net_out'];

export const PERCENT_MAX = 100;
const BYTES_PER_UNIT = 1024;
const RATE_UNITS = ['B/s', 'KB/s', 'MB/s', 'GB/s'] as const;
export type RateUnitLabel = (typeof RATE_UNITS)[number];

/** Headroom above the busiest point so the line never touches the top edge. */
const RATE_HEADROOM = 1.1;
const NICE_STEPS = [1, 2, 2.5, 5, 10] as const;

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86_400;

/** One chart row. Percent fields are 0 to 100; net fields are in the chosen rate unit. */
export interface ChartRow {
  ts: number;
  cpu: number | null;
  mem: number | null;
  disk: number | null;
  net_in: number | null;
  net_out: number | null;
}

export interface RateUnit {
  label: RateUnitLabel;
  /** Bytes per second per displayed unit. */
  divisor: number;
}

const finite = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

/** The largest unit that keeps the busiest value at 1 or more: 38.2 MB/s, not 0.0 GB/s. */
export function pickRateUnit(maxBytesPerSecond: number): RateUnit {
  let index = 0;
  let divisor = 1;
  while (index < RATE_UNITS.length - 1 && maxBytesPerSecond >= divisor * BYTES_PER_UNIT) {
    divisor *= BYTES_PER_UNIT;
    index += 1;
  }
  return { label: RATE_UNITS[index] ?? 'B/s', divisor };
}

/** Busiest network value in the response (points, stats and the rate thresholds), in B/s. */
export function maxRate(series: Pick<SeriesResponse, 'points' | 'stats'>): number {
  let max = 0;
  for (const point of series.points) {
    if (finite(point.net_in)) max = Math.max(max, point.net_in);
    if (finite(point.net_out)) max = Math.max(max, point.net_out);
  }
  for (const field of ['net_in', 'net_out'] as const) {
    const stat = series.stats[field];
    if (stat) max = Math.max(max, stat.max);
  }
  return max;
}

const scale = (value: number | null, divisor: number): number | null => (finite(value) ? value / divisor : null);

export function toChartRows(points: readonly SeriesPoint[], rate: RateUnit): ChartRow[] {
  const rows: ChartRow[] = [];
  for (const point of points) {
    const ts = toTime(point.t);
    if (ts === null) continue;
    rows.push({
      ts,
      cpu: finite(point.cpu) ? point.cpu : null,
      mem: finite(point.mem) ? point.mem : null,
      disk: finite(point.disk) ? point.disk : null,
      net_in: scale(point.net_in, rate.divisor),
      net_out: scale(point.net_out, rate.divisor),
    });
  }
  return rows;
}

export interface TimeSpan {
  from: number;
  to: number;
}

const hasData = (row: ChartRow): boolean => SERIES_FIELDS.some((field) => row[field] !== null);

export interface GapReport {
  /** Spans with no data between two reported points, from the last point before to the first after. */
  gaps: TimeSpan[];
  /** From the last reported point to the end of the range, when the newest steps are empty. */
  trailing: TimeSpan | null;
  /** How many empty steps the trailing span covers. */
  trailingSteps: number;
  /** True when no row has any data. */
  empty: boolean;
}

/**
 * Finds the breaks in a series. Leading empty steps (before the server
 * existed or before history begins) are not gaps.
 */
export function findGaps(rows: readonly ChartRow[], rangeEnd: number): GapReport {
  const gaps: TimeSpan[] = [];
  let lastData = -1;
  rows.forEach((row, index) => {
    if (!hasData(row)) return;
    if (lastData !== -1 && index - lastData > 1) {
      const before = rows[lastData];
      if (before) gaps.push({ from: before.ts, to: row.ts });
    }
    lastData = index;
  });
  const last = rows[lastData];
  const trailingSteps = lastData === -1 ? 0 : rows.length - 1 - lastData;
  return {
    gaps,
    trailing: last && trailingSteps > 0 ? { from: last.ts, to: Math.max(last.ts, rangeEnd) } : null,
    trailingSteps,
    empty: lastData === -1,
  };
}

/** Fields the agent never reported in this range, while others did (e.g. an old agent without network). */
export function unreportedFields(rows: readonly ChartRow[]): SeriesField[] {
  if (!rows.some(hasData)) return [];
  return SERIES_FIELDS.filter((field) => rows.every((row) => row[field] === null));
}

/** 1, 2, 2.5 or 5 times a power of ten, at or above the value. */
export function niceCeil(value: number): number {
  if (!finite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const fraction = value / magnitude;
  const step = NICE_STEPS.find((candidate) => fraction <= candidate) ?? 10;
  return step * magnitude;
}

/** Top of a rate chart's y axis, in display units, keeping thresholds on screen. */
export function rateAxisMax(rows: readonly ChartRow[], thresholdsInUnit: readonly number[]): number {
  let max = 0;
  for (const row of rows) {
    if (row.net_in !== null) max = Math.max(max, row.net_in);
    if (row.net_out !== null) max = Math.max(max, row.net_out);
  }
  for (const value of thresholdsInUnit) max = Math.max(max, value);
  return niceCeil(max * RATE_HEADROOM);
}

/** `count` evenly spaced timestamps from `from` to `to`, both ends included. */
export function timeTicks(from: number, to: number, count: number): number[] {
  if (count < 2 || to <= from) return [from];
  const step = (to - from) / (count - 1);
  return Array.from({ length: count }, (_, index) => Math.round(from + step * index));
}

/** y ticks at quarters; only 0, half and max get a label (ServerDetail.dc.html). */
export function quarterTicks(max: number): number[] {
  return [0, max / 4, max / 2, (max * 3) / 4, max];
}

const hourMinute = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const hourMinuteSecond = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const weekdayHourMinute = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const weekdayDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' });
const monthDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const monthDayTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** x-axis tick label: 14:27 up to 24 h (the first 24 h tick gets its weekday), "Sun 8" for 7 d, "Oct 16" for 30 d. */
export function formatTick(ts: number, range: SeriesRange, first = false): string {
  switch (range) {
    case 'live':
    case '1h':
    case '6h':
      return hourMinute.format(ts);
    case '24h':
      return first ? weekdayHourMinute.format(ts) : hourMinute.format(ts);
    case '7d':
      return weekdayDay.format(ts);
    case '30d':
      return monthDay.format(ts);
  }
}

/** The crosshair time in the readout: seconds for short ranges, the day for long ones. */
export function formatHoverTime(ts: number, range: SeriesRange): string {
  switch (range) {
    case 'live':
    case '1h':
      return hourMinuteSecond.format(ts);
    case '6h':
      return hourMinute.format(ts);
    case '24h':
      return weekdayHourMinute.format(ts);
    case '7d':
    case '30d':
      return monthDayTime.format(ts);
  }
}

/** "5 s", "1 min", "4 min", "1 h". */
export function formatStep(seconds: number): string {
  if (seconds < SECONDS_PER_MINUTE) return `${Math.max(1, Math.round(seconds))} s`;
  if (seconds < SECONDS_PER_HOUR) return `${Math.round(seconds / SECONDS_PER_MINUTE)} min`;
  return `${Math.round(seconds / SECONDS_PER_HOUR)} h`;
}

/** "15 min", "hour", "6 hours", "7 days". */
export function formatSpan(seconds: number): string {
  if (seconds < SECONDS_PER_HOUR) return `${Math.round(seconds / SECONDS_PER_MINUTE)} min`;
  if (seconds < SECONDS_PER_DAY * 2) {
    const hours = Math.round(seconds / SECONDS_PER_HOUR);
    return hours === 1 ? 'hour' : `${hours} hours`;
  }
  return `${Math.round(seconds / SECONDS_PER_DAY)} days`;
}

/** ServerDetail.dc.html range note: "last 6 hours · 1 min resolution", from the response itself. */
export function rangeNote(series: Pick<SeriesResponse, 'from' | 'to' | 'step_seconds'>): string {
  const from = toTime(series.from);
  const to = toTime(series.to);
  if (from === null || to === null || to <= from) return '';
  return `last ${formatSpan((to - from) / MS_PER_SECOND)} · ${formatStep(series.step_seconds)} resolution`;
}

/** "No data 13:02–13:09" for a gap. */
export function formatGap(gap: TimeSpan, range: SeriesRange): string {
  const format = range === '7d' || range === '30d' ? monthDayTime : hourMinute;
  return `${format.format(gap.from)}–${format.format(gap.to)}`;
}

export type ValueKind = 'percent' | 'rate';

/** A chart value without its unit: "41.6" for percent, "38.2" in the rate unit. */
export function formatValue(value: number | null | undefined, kind: ValueKind, rate?: RateUnit): string {
  if (!finite(value)) return EMPTY_VALUE;
  if (kind === 'percent') return value.toFixed(1);
  return formatCompact(value / (rate?.divisor ?? 1));
}

export interface StatChips {
  min: string;
  avg: string;
  max: string;
  now: string;
}

/** min/avg/max/now from the response's stats, in display form. Values are raw (B/s for rates). */
export function statChips(stat: SeriesStat | undefined, kind: ValueKind, rate?: RateUnit): StatChips | null {
  if (!stat) return null;
  return {
    min: formatValue(stat.min, kind, rate),
    avg: formatValue(stat.avg, kind, rate),
    max: formatValue(stat.max, kind, rate),
    now: formatValue(stat.now, kind, rate),
  };
}

/** The newest row with any data, for the readout before the pointer moves. */
export function latestRowIndex(rows: readonly ChartRow[]): number | null {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (row && hasData(row)) return index;
  }
  return null;
}

// ---------------------------------------------------------------- chart specs

export type ChartKey = 'cpu' | 'mem' | 'disk' | 'net';
export type SeriesTone = 'in' | 'out';

export interface ChartSeriesSpec {
  field: SeriesField;
  /** Legend and readout name: "CPU", "In". */
  label: string;
  tone: SeriesTone;
  fillOpacity: number;
}

export interface ChartThreshold {
  severity: Severity;
  /** In the chart's display unit. */
  value: number;
  /** "warn 85%", "crit 100 MB/s", "in warn 80 MB/s". */
  label: string;
  field: SeriesField;
}

export interface ChartSpec {
  key: ChartKey;
  title: string;
  /** Muted hint beside the title: "% of 8 cores", "MB/s". */
  unitHint: string;
  kind: ValueKind;
  /** Top of the y axis in display units. */
  max: number;
  series: ChartSeriesSpec[];
  thresholds: ChartThreshold[];
}

const AREA_OPACITY = 0.16;
const SECONDARY_AREA_OPACITY = 0.08;
const SEVERITY_SHORT: Record<Severity, string> = { warning: 'warn', critical: 'crit' };

export interface ChartSpecInput {
  rows: readonly ChartRow[];
  rate: RateUnit;
  thresholds: Partial<Record<string, ThresholdPair>>;
  latest: Pick<ServerLatest, 'cpu_cores' | 'mem_total' | 'disk_total'> | null;
}

function percentThresholds(field: SeriesField, pair: ThresholdPair | undefined): ChartThreshold[] {
  return thresholdLines(pair).map((line) => ({
    severity: line.severity,
    value: line.value,
    label: `${SEVERITY_SHORT[line.severity]} ${formatThreshold(line.value, '%')}`,
    field,
  }));
}

function rateThresholds(field: 'net_in' | 'net_out', pair: ThresholdPair | undefined, rate: RateUnit, prefix: boolean): ChartThreshold[] {
  const direction = field === 'net_in' ? 'in' : 'out';
  return thresholdLines(pair).map((line) => ({
    severity: line.severity,
    value: line.value / rate.divisor,
    label: `${prefix ? `${direction} ` : ''}${SEVERITY_SHORT[line.severity]} ${formatCompact(line.value / rate.divisor)} ${rate.label}`,
    field,
  }));
}

/** The four charts of ServerDetail.dc.html: CPU, Memory, Disk / and Network (in and out). */
export function buildChartSpecs({ rows, rate, thresholds, latest }: ChartSpecInput): ChartSpec[] {
  const cores = latest?.cpu_cores ?? 0;
  const of = (total: number | undefined): string => (total !== undefined && total > 0 ? `% of ${formatBytes(total)}` : '%');
  const netIn = thresholds.net_in;
  const netOut = thresholds.net_out;
  const bothRates = hasThreshold(netIn) && hasThreshold(netOut);
  const networkThresholds = [...rateThresholds('net_in', netIn, rate, bothRates), ...rateThresholds('net_out', netOut, rate, bothRates)];
  return [
    {
      key: 'cpu',
      title: 'CPU',
      unitHint: cores > 0 ? `% of ${cores} ${cores === 1 ? 'core' : 'cores'}` : '%',
      kind: 'percent',
      max: PERCENT_MAX,
      series: [{ field: 'cpu', label: 'CPU', tone: 'in', fillOpacity: AREA_OPACITY }],
      thresholds: percentThresholds('cpu', thresholds.cpu),
    },
    {
      key: 'mem',
      title: 'Memory',
      unitHint: of(latest?.mem_total),
      kind: 'percent',
      max: PERCENT_MAX,
      series: [{ field: 'mem', label: 'Mem', tone: 'in', fillOpacity: AREA_OPACITY }],
      thresholds: percentThresholds('mem', thresholds.mem),
    },
    {
      key: 'disk',
      title: 'Disk /',
      unitHint: of(latest?.disk_total),
      kind: 'percent',
      max: PERCENT_MAX,
      series: [{ field: 'disk', label: 'Disk', tone: 'in', fillOpacity: AREA_OPACITY }],
      thresholds: percentThresholds('disk', thresholds.disk),
    },
    {
      key: 'net',
      title: 'Network',
      unitHint: rate.label,
      kind: 'rate',
      max: rateAxisMax(rows, networkThresholds.map((line) => line.value)),
      series: [
        { field: 'net_in', label: 'In', tone: 'in', fillOpacity: AREA_OPACITY },
        { field: 'net_out', label: 'Out', tone: 'out', fillOpacity: SECONDARY_AREA_OPACITY },
      ],
      thresholds: networkThresholds,
    },
  ];
}

export type LabelPlacement = 'above' | 'below';

export interface PlotBox {
  /** y-axis top in display units. */
  max: number;
  /** Plot area top and height in px. */
  top: number;
  height: number;
  labelHeight: number;
  /** Space between a line and its label, px. */
  gap: number;
}

/**
 * Where each threshold label goes, in input order: above its line when there
 * is room (inside the plot and clear of the label over it), else below.
 */
export function placeThresholdLabels(values: readonly number[], box: PlotBox): LabelPlacement[] {
  const y = (value: number): number => box.top + (1 - value / (box.max || 1)) * box.height;
  const out: LabelPlacement[] = values.map(() => 'above');
  let occupiedTo = Number.NEGATIVE_INFINITY;
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value);
  for (const { value, index } of order) {
    const line = y(value);
    const aboveTop = line - box.gap - box.labelHeight;
    if (aboveTop >= 0 && aboveTop >= occupiedTo) {
      out[index] = 'above';
      occupiedTo = line - box.gap;
    } else {
      out[index] = 'below';
      occupiedTo = line + box.gap + box.labelHeight;
    }
  }
  return out;
}

/** Severity of a value against the chart's lines for that field (display units, strictly above). */
export function valueSeverity(value: number | null, field: SeriesField, lines: readonly ChartThreshold[]): Severity | null {
  if (value === null) return null;
  let worst: Severity | null = null;
  for (const line of lines) {
    if (line.field !== field || value <= line.value) continue;
    if (line.severity === 'critical') return 'critical';
    worst = 'warning';
  }
  return worst;
}
