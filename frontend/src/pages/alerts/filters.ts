/**
 * Alerts page filters: the URL is the source of truth (shareable, back button
 * works), mapped onto GET /incidents params where the API can filter and
 * applied locally where it cannot (network covers net_in and net_out).
 */
import type { Incident, IncidentMetric, IncidentState, Severity } from '../../api/types';
import type { IncidentPageFilters } from '../../hooks/api/incidentPages';
import { presentIncident } from '../../lib/status';

export const STATE_TABS = ['open', 'acked', 'resolved', 'all'] as const;
export type StateTab = (typeof STATE_TABS)[number];

export const TYPE_FILTERS = ['all', 'cpu', 'memory', 'disk', 'network', 'load', 'swap', 'unreachable', 'uptime'] as const;
export type TypeFilter = (typeof TYPE_FILTERS)[number];

export const TYPE_LABELS: Record<TypeFilter, string> = {
  all: 'All types',
  cpu: 'CPU',
  memory: 'Memory',
  disk: 'Disk',
  network: 'Network',
  load: 'Load',
  swap: 'Swap',
  unreachable: 'Unreachable',
  uptime: 'Uptime checks',
};

/** Which incident metrics each type covers. */
const TYPE_METRICS: Record<Exclude<TypeFilter, 'all'>, readonly IncidentMetric[]> = {
  cpu: ['cpu'],
  memory: ['memory'],
  disk: ['disk'],
  network: ['net_in', 'net_out'],
  load: ['load1'],
  swap: ['swap'],
  unreachable: ['heartbeat'],
  uptime: ['http', 'tcp', 'tls', 'tls_expiry'],
};

export const SEVERITIES: readonly Severity[] = ['critical', 'warning'];

export interface AlertFilters {
  state: StateTab;
  /** Shown severities; both means no severity filter, none means nothing matches. */
  severities: readonly Severity[];
  type: TypeFilter;
  serverId: number | null;
}

export const DEFAULT_FILTERS: AlertFilters = { state: 'open', severities: SEVERITIES, type: 'all', serverId: null };

export const PARAMS = { state: 'state', severity: 'severity', type: 'type', server: 'server' } as const;
const NO_SEVERITY = 'none';
const POSITIVE_INT = /^[1-9]\d*$/;

const oneOf = <T extends string>(values: readonly T[], raw: string | null): T | undefined => values.find((value) => value === raw);

export function parseFilters(params: URLSearchParams): AlertFilters {
  const state = oneOf(STATE_TABS, params.get(PARAMS.state)) ?? DEFAULT_FILTERS.state;
  const type = oneOf(TYPE_FILTERS, params.get(PARAMS.type)) ?? DEFAULT_FILTERS.type;
  const rawSeverity = params.get(PARAMS.severity);
  const severities =
    rawSeverity === null
      ? SEVERITIES
      : rawSeverity === NO_SEVERITY
        ? []
        : SEVERITIES.filter((severity) => rawSeverity.split(',').includes(severity));
  const rawServer = params.get(PARAMS.server);
  const serverId = rawServer !== null && POSITIVE_INT.test(rawServer) ? Number(rawServer) : null;
  return { state, severities: severities.length === 0 && rawSeverity !== NO_SEVERITY ? SEVERITIES : severities, type, serverId };
}

/** Writes filters into the params, leaving defaults out so URLs stay short. Other params are kept. */
export function writeFilters(params: URLSearchParams, filters: AlertFilters): URLSearchParams {
  const out = new URLSearchParams(params);
  const set = (key: string, value: string | null): void => {
    if (value === null) out.delete(key);
    else out.set(key, value);
  };
  set(PARAMS.state, filters.state === DEFAULT_FILTERS.state ? null : filters.state);
  set(PARAMS.type, filters.type === 'all' ? null : filters.type);
  set(PARAMS.server, filters.serverId === null ? null : String(filters.serverId));
  const all = SEVERITIES.every((severity) => filters.severities.includes(severity));
  set(PARAMS.severity, all ? null : filters.severities.length === 0 ? NO_SEVERITY : SEVERITIES.filter((s) => filters.severities.includes(s)).join(','));
  return out;
}

/** True when anything narrows the list beyond the state tab. */
export function isFiltered(filters: AlertFilters): boolean {
  return filters.type !== 'all' || filters.serverId !== null || filters.severities.length !== SEVERITIES.length;
}

/** False when the filters can match nothing, so no request is needed. */
export function canMatch(filters: AlertFilters): boolean {
  return filters.severities.length > 0;
}

/** The GET /incidents params for these filters. */
export function toApiFilters(filters: AlertFilters): IncidentPageFilters {
  const out: IncidentPageFilters = { state: filters.state };
  if (filters.severities.length === 1 && filters.severities[0]) out.severity = filters.severities[0];
  if (filters.type !== 'all') {
    const metrics = TYPE_METRICS[filters.type];
    if (metrics.length === 1 && metrics[0]) out.metric = metrics[0];
  }
  if (filters.serverId !== null) out.server_id = filters.serverId;
  return out;
}

/** The part of the filters the API could not apply (and a safety net for live-patched rows). */
export function matchesFilters(incident: Incident, filters: AlertFilters): boolean {
  if (filters.state !== 'all' && incident.state !== filters.state) return false;
  if (!filters.severities.includes(incident.severity)) return false;
  if (filters.type !== 'all' && !TYPE_METRICS[filters.type].includes(incident.metric)) return false;
  if (filters.serverId !== null && incident.server_id !== filters.serverId) return false;
  return true;
}

export interface IncidentGroup {
  state: IncidentState;
  label: string;
  incidents: Incident[];
}

const GROUP_LABELS: Record<IncidentState, string> = { open: 'Open', acked: 'Acknowledged', resolved: 'Resolved' };
const GROUP_ORDER: readonly IncidentState[] = ['open', 'acked', 'resolved'];
const RANK: Record<string, number> = { critical: 0, offline: 1, warning: 2, healthy: 3 };

const byWorstThenNewest = (a: Incident, b: Incident): number =>
  (RANK[presentIncident(a).status] ?? 0) - (RANK[presentIncident(b).status] ?? 0) || Date.parse(b.started_at) - Date.parse(a.started_at);

/**
 * Alerts.dc.html groups: one card per state. A single-state tab always shows
 * its group (empty or not); "all" shows the states that have incidents.
 * Active groups sort worst first, then newest; resolved keeps API order.
 */
export function groupIncidents(incidents: readonly Incident[], tab: StateTab): IncidentGroup[] {
  const states = tab === 'all' ? GROUP_ORDER : [tab];
  const groups = states.map((state) => {
    const items = incidents.filter((incident) => incident.state === state);
    return { state, label: GROUP_LABELS[state], incidents: state === 'resolved' ? items : [...items].sort(byWorstThenNewest) };
  });
  return tab === 'all' ? groups.filter((group) => group.incidents.length > 0) : groups;
}
