/** Overview logic: counting, filtering, sorting and the verdict line. */
import type { Incident, ServerStatus, ServerSummary } from '../api/types';

import { formatAge, secondsSince } from './format';
import { compareStatus, formatMetricValue, metricLabel, presentIncident } from './status';

export type StatusCounts = Record<ServerStatus, number> & { all: number };

export function countByStatus(servers: readonly ServerSummary[]): StatusCounts {
  const counts: StatusCounts = { all: servers.length, healthy: 0, warning: 0, critical: 0, offline: 0 };
  for (const server of servers) counts[server.status] += 1;
  return counts;
}

/** Every tag in use, sorted, for the filter chips. */
export function collectTags(servers: readonly ServerSummary[]): string[] {
  return [...new Set(servers.flatMap((server) => server.tags))].sort((a, b) => a.localeCompare(b));
}

export const SORT_KEYS = ['status', 'name', 'cpu', 'mem', 'disk'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const SORT_LABELS: Record<SortKey, string> = {
  status: 'Status (worst first)',
  name: 'Name',
  cpu: 'CPU',
  mem: 'Memory',
  disk: 'Disk',
};

export interface FleetFilter {
  query: string;
  /** null = all tags */
  tag: string | null;
  /** null = every status */
  status: ServerStatus | null;
}

export function filterServers(servers: readonly ServerSummary[], filter: FleetFilter): ServerSummary[] {
  const query = filter.query.trim().toLowerCase();
  return servers.filter(
    (server) =>
      (query === '' || server.name.toLowerCase().includes(query) || server.tags.some((tag) => tag.toLowerCase() === query)) &&
      (filter.tag === null || server.tags.includes(filter.tag)) &&
      (filter.status === null || server.status === filter.status),
  );
}

const byName = (a: ServerSummary, b: ServerSummary): number => a.name.localeCompare(b.name);

/** Highest value first; servers without a reading sink to the bottom. */
const byMetric =
  (metric: 'cpu' | 'mem' | 'disk') =>
  (a: ServerSummary, b: ServerSummary): number => {
    const av = a.latest?.[metric] ?? Number.NEGATIVE_INFINITY;
    const bv = b.latest?.[metric] ?? Number.NEGATIVE_INFINITY;
    return bv - av || byName(a, b);
  };

export function sortServers(servers: readonly ServerSummary[], key: SortKey): ServerSummary[] {
  const sorted = [...servers];
  switch (key) {
    case 'status':
      return sorted.sort((a, b) => compareStatus(a.status, b.status) || byName(a, b));
    case 'name':
      return sorted.sort(byName);
    case 'cpu':
    case 'mem':
    case 'disk':
      return sorted.sort(byMetric(key));
  }
}

export type VerdictKind = 'empty' | 'healthy' | 'attention' | 'critical';

export interface VerdictReason {
  /** Lower-case subject: "disk", "cpu", "no heartbeat". */
  subject: string;
  /** Current value, e.g. "94.2%"; null when there is none (heartbeat). */
  value: string | null;
  /** How long, e.g. "23 min"; null if unknown. */
  duration: string | null;
}

export interface Verdict {
  kind: VerdictKind;
  critical: number;
  /** warning + offline */
  attention: number;
  total: number;
  /** The worst server, linked from the verdict line. */
  worst: ServerSummary | null;
  reason: VerdictReason | null;
}

function worstIncidentFor(serverId: number, incidents: readonly Incident[]): Incident | null {
  const candidates = incidents.filter((incident) => incident.server_id === serverId && incident.state !== 'resolved');
  candidates.sort((a, b) => {
    const rank = compareStatus(presentIncident(a).status, presentIncident(b).status);
    return rank || Date.parse(a.started_at) - Date.parse(b.started_at);
  });
  return candidates[0] ?? null;
}

function reasonFor(server: ServerSummary, incidents: readonly Incident[], now: number): VerdictReason | null {
  const incident = worstIncidentFor(server.id, incidents);
  if (incident) {
    const since = secondsSince(incident.started_at, now);
    return {
      subject: incident.metric === 'heartbeat' ? 'no heartbeat' : metricLabel(incident.metric).toLowerCase(),
      value: incident.metric === 'heartbeat' ? null : formatMetricValue(incident.last_value, incident.unit),
      duration: since === null ? null : formatAge(since),
    };
  }
  if (server.status === 'offline') {
    const since = secondsSince(server.last_seen, now);
    return { subject: 'no heartbeat', value: null, duration: since === null ? null : formatAge(since) };
  }
  return null;
}

/** The verdict's headline category, from counts alone. */
export function verdictKind(counts: StatusCounts): VerdictKind {
  if (counts.all === 0) return 'empty';
  if (counts.critical > 0) return 'critical';
  return counts.warning + counts.offline > 0 ? 'attention' : 'healthy';
}

export function buildVerdict(servers: readonly ServerSummary[], incidents: readonly Incident[], now: number): Verdict {
  const counts = countByStatus(servers);
  const attention = counts.warning + counts.offline;
  const kind = verdictKind(counts);
  const worst =
    kind === 'critical' || kind === 'attention'
      ? ([...servers].sort((a, b) => compareStatus(a.status, b.status) || a.name.localeCompare(b.name))[0] ?? null)
      : null;
  return {
    kind,
    critical: counts.critical,
    attention,
    total: counts.all,
    worst,
    reason: worst ? reasonFor(worst, incidents, now) : null,
  };
}

/** "1 server critical", "3 servers need attention", "1 needs attention". */
export function verdictHeadline(verdict: Verdict): { primary: string; secondary: string | null } {
  const needs = (count: number): string => (count === 1 ? 'needs attention' : 'need attention');
  if (verdict.kind === 'critical') {
    return {
      primary: `${verdict.critical} ${verdict.critical === 1 ? 'server' : 'servers'} critical`,
      secondary: verdict.attention > 0 ? `${verdict.attention} ${needs(verdict.attention)}` : null,
    };
  }
  if (verdict.kind === 'attention') {
    return { primary: `${verdict.attention} ${verdict.attention === 1 ? 'server' : 'servers'} ${needs(verdict.attention)}`, secondary: null };
  }
  if (verdict.kind === 'healthy') {
    return { primary: verdict.total === 1 ? 'Your server is healthy' : `All ${verdict.total} servers healthy`, secondary: null };
  }
  return { primary: 'No servers yet', secondary: null };
}
