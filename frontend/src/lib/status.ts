/**
 * Status encoding (Tokens.dc.html "Status encoding"): every status is colour +
 * shape + word. These helpers map API values onto that vocabulary.
 */
import type { Incident, MetricKey, MetricUnit, ServerStatus, Severity } from '../api/types';

import { formatPercent, formatRate } from './format';

export interface StatusMeta {
  label: string;
  /** Sort rank, worst first (Main.dc.html sorts critical, warning, offline, healthy). */
  rank: number;
}

export const STATUS_META: Record<ServerStatus, StatusMeta> = {
  critical: { label: 'Critical', rank: 0 },
  warning: { label: 'Warning', rank: 1 },
  offline: { label: 'Offline', rank: 2 },
  healthy: { label: 'Healthy', rank: 3 },
};

export const SERVER_STATUSES: readonly ServerStatus[] = ['healthy', 'warning', 'critical', 'offline'];

export function compareStatus(a: ServerStatus, b: ServerStatus): number {
  return STATUS_META[a].rank - STATUS_META[b].rank;
}

/** Worst status in the list, or null for an empty list. */
export function worstStatus(statuses: Iterable<ServerStatus>): ServerStatus | null {
  let worst: ServerStatus | null = null;
  for (const status of statuses) {
    if (worst === null || compareStatus(status, worst) < 0) worst = status;
  }
  return worst;
}

export const METRIC_LABELS: Record<MetricKey, string> = {
  cpu: 'CPU',
  memory: 'Memory',
  disk: 'Disk',
  net_in: 'Network in',
  net_out: 'Network out',
  heartbeat: 'Heartbeat',
};

/** How an incident is drawn: badge status, badge word and the left bar tone. */
export interface IncidentPresentation {
  status: ServerStatus;
  label: string;
  bar: 'crit' | 'warn' | 'off' | 'resolved';
}

/**
 * Alerts.dc.html: a missing heartbeat reads as "Unreachable" with the offline
 * shape; resolved incidents read as "Resolved" with the healthy shape.
 */
export function presentIncident(incident: Pick<Incident, 'state' | 'metric' | 'severity'>): IncidentPresentation {
  if (incident.state === 'resolved') return { status: 'healthy', label: 'Resolved', bar: 'resolved' };
  if (incident.metric === 'heartbeat') return { status: 'offline', label: 'Unreachable', bar: 'off' };
  if (incident.severity === 'critical') return { status: 'critical', label: 'Critical', bar: 'crit' };
  return { status: 'warning', label: 'Warning', bar: 'warn' };
}

export function formatMetricValue(value: number, unit: MetricUnit): string {
  if (unit === '%') return formatPercent(value);
  if (unit === 'B/s') return formatRate(value);
  return String(Math.round(value));
}

/** Threshold without needless decimals: 90%, 85.5%, 100 MB/s. */
export function formatThreshold(value: number, unit: MetricUnit): string {
  if (unit === '%') return `${Number.isInteger(value) ? value.toString() : value.toFixed(1)}%`;
  return formatMetricValue(value, unit);
}

/**
 * "Disk above 90%", "No heartbeat". Uses the incident's comparison; without
 * one (older payloads) it is inferred: incidents open on a breach, so a peak
 * at or over the threshold means the rule was "above".
 */
export function incidentTitle(
  incident: Pick<Incident, 'metric' | 'threshold' | 'peak' | 'unit'> & Partial<Pick<Incident, 'comparison'>>,
): string {
  if (incident.metric === 'heartbeat') return 'No heartbeat';
  const comparison = incident.comparison ?? (incident.peak >= incident.threshold ? 'above' : 'below');
  return `${METRIC_LABELS[incident.metric]} ${comparison} ${formatThreshold(incident.threshold, incident.unit)}`;
}

/** Server metrics that have a sparkline column on the overview. */
export type FleetMetric = 'cpu' | 'mem' | 'disk';

const INCIDENT_TO_FLEET_METRIC: Partial<Record<MetricKey, FleetMetric>> = {
  cpu: 'cpu',
  memory: 'mem',
  disk: 'disk',
};

export type MetricBreaches = Partial<Record<FleetMetric, Severity>>;

/**
 * Which overview metrics are over a threshold, per server, from active
 * incidents. The fallback for metrics without an entry in
 * ServerSummary.thresholds (see metricSeverity in components/serverMetrics).
 */
export function breachesByServer(incidents: readonly Incident[]): Map<number, MetricBreaches> {
  const out = new Map<number, MetricBreaches>();
  for (const incident of incidents) {
    if (incident.state === 'resolved') continue;
    const metric = INCIDENT_TO_FLEET_METRIC[incident.metric];
    if (!metric) continue;
    const current = out.get(incident.server_id) ?? {};
    if (current[metric] !== 'critical') current[metric] = incident.severity;
    out.set(incident.server_id, current);
  }
  return out;
}

// Main.dc.html rail order: critical, then unreachable, then warning.
const RAIL_RANK: Record<ServerStatus, number> = { critical: 0, offline: 1, warning: 2, healthy: 3 };
const severityRank = (incident: Incident): number => RAIL_RANK[presentIncident(incident).status];

/** Rail order: unacknowledged first, then critical, unreachable, warning, then newest. */
export function sortActiveIncidents(incidents: readonly Incident[]): Incident[] {
  return incidents
    .filter((incident) => incident.state !== 'resolved')
    .sort((a, b) => {
      const acked = Number(a.state === 'acked') - Number(b.state === 'acked');
      if (acked !== 0) return acked;
      const severity = severityRank(a) - severityRank(b);
      if (severity !== 0) return severity;
      return Date.parse(b.started_at) - Date.parse(a.started_at);
    });
}
