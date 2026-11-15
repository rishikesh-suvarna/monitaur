/**
 * The samples chart in an expanded alert row (Alerts.dc.html): the metric
 * around the incident, zoomed on its threshold. Pure helpers, so the window,
 * range and scale are testable without a chart.
 */
import type { Incident, IncidentMetric, SeriesField, SeriesPoint, SeriesRange } from '../api/types';

const MS_PER_SECOND = 1000;

/** Incident metrics that have a server series; heartbeats and uptime checks do not. */
const SERIES_FIELD: Partial<Record<IncidentMetric, SeriesField>> = {
  cpu: 'cpu',
  memory: 'mem',
  disk: 'disk',
  net_in: 'net_in',
  net_out: 'net_out',
  load1: 'load1',
  swap: 'swap',
};

export function incidentSeriesField(metric: IncidentMetric): SeriesField | null {
  return SERIES_FIELD[metric] ?? null;
}

/** Ranges the series endpoint serves, shortest first, with how far back each reaches. */
const RANGES: readonly (readonly [SeriesRange, number])[] = [
  ['1h', 3_600],
  ['6h', 21_600],
  ['24h', 86_400],
  ['7d', 604_800],
  ['30d', 2_592_000],
];

/** Time shown before the incident started, so the chart shows the breach building. */
const LEAD_FRACTION = 0.25;
const MIN_LEAD_SECONDS = 300;

export interface SampleWindow {
  /** ms since the epoch */
  from: number;
  to: number;
}

export function incidentWindow(incident: Pick<Incident, 'started_at' | 'resolved_at'>, now: number): SampleWindow | null {
  const start = Date.parse(incident.started_at);
  if (!Number.isFinite(start)) return null;
  const resolved = incident.resolved_at === null ? Number.NaN : Date.parse(incident.resolved_at);
  const end = Number.isFinite(resolved) ? Math.min(resolved, now) : now;
  const lead = Math.max(MIN_LEAD_SECONDS * MS_PER_SECOND, (end - start) * LEAD_FRACTION);
  return { from: start - lead, to: Math.max(end, start) };
}

/** The shortest range (anchored at now) that still reaches back to the window's start; 30d at most. */
export function rangeFor(window: SampleWindow, now: number): SeriesRange {
  const back = (now - window.from) / MS_PER_SECOND;
  return RANGES.find(([, seconds]) => back <= seconds)?.[0] ?? '30d';
}

/** The field's values inside the window, oldest first; gaps stay null. */
export function windowValues(points: readonly SeriesPoint[], field: SeriesField, window: SampleWindow): (number | null)[] {
  return points
    .filter((point) => {
      const t = Date.parse(point.t);
      return t >= window.from && t <= window.to;
    })
    .map((point) => point[field]);
}

const PERCENT_TOP = 100;
/** Alerts.dc.html: the y axis runs from 90% of the threshold to 2% over the scale. */
const FLOOR_FRACTION = 0.9;
const TOP_HEADROOM = 1.02;
const RATE_HEADROOM = 1.25;

export interface SamplesDomain {
  min: number;
  max: number;
}

/**
 * Zoomed on the threshold, like the design: values well under it clamp to the
 * floor. A "below" rule breaches under its threshold, so it keeps zero as the
 * floor instead.
 */
export function samplesDomain(
  values: readonly (number | null)[],
  incident: Pick<Incident, 'threshold' | 'unit' | 'comparison'>,
): SamplesDomain {
  const seen = values.filter((value): value is number => value !== null && Number.isFinite(value));
  const highest = seen.length > 0 ? Math.max(...seen) : incident.threshold;
  const top = incident.unit === '%' ? PERCENT_TOP : Math.max(highest, incident.threshold) * RATE_HEADROOM;
  const min = incident.comparison === 'below' ? 0 : incident.threshold * FLOOR_FRACTION;
  return { min, max: Math.max(top * TOP_HEADROOM, min + 1) };
}
