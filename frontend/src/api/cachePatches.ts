/**
 * Pure functions that fold live (SSE) and mutation results into cached query
 * data. They return the same reference when nothing changed so React Query
 * does not notify subscribers needlessly.
 */
import type {
  Check,
  CheckResult,
  ChecksResponse,
  Incident,
  IncidentCounts,
  IncidentFilters,
  IncidentsResponse,
  IncidentStreamEvent,
  ServerDetailResponse,
  ServersResponse,
  ServerSummary,
  StreamCheckUpdate,
  StreamServerUpdate,
} from './types';

export interface ServersPatchResult {
  next: ServersResponse;
  /** Ids in the stream that are not in the cache (created elsewhere). */
  unknownIds: number[];
}

const sameLatest = (a: ServerSummary['latest'], b: ServerSummary['latest']): boolean =>
  a === b || (a !== null && b !== null && a.at === b.at && a.cpu === b.cpu && a.mem === b.mem && a.disk === b.disk);

function applyUpdate(server: ServerSummary, update: StreamServerUpdate): ServerSummary {
  const agentVersion = update.agent_version ?? server.agent_version;
  const maintenance = update.maintenance ?? server.maintenance;
  if (
    server.status === update.status &&
    server.connected === update.connected &&
    server.last_seen === update.last_seen &&
    server.agent_version === agentVersion &&
    server.maintenance === maintenance &&
    sameLatest(server.latest, update.latest)
  ) {
    return server;
  }
  return {
    ...server,
    status: update.status,
    connected: update.connected,
    last_seen: update.last_seen,
    latest: update.latest,
    agent_version: agentVersion,
    maintenance,
  };
}

/** Merges a `servers` SSE payload into the GET /servers cache entry. */
export function patchServersList(current: ServersResponse, updates: readonly StreamServerUpdate[]): ServersPatchResult {
  const byId = new Map(updates.map((update) => [update.id, update]));
  let changed = false;
  const servers: ServerSummary[] = [];
  for (const server of current.servers) {
    const update = byId.get(server.id);
    byId.delete(server.id);
    const next = update ? applyUpdate(server, update) : server;
    if (next !== server) changed = true;
    servers.push(next);
  }
  return { next: changed ? { ...current, servers } : current, unknownIds: [...byId.keys()] };
}

/** Merges one server's SSE update into a GET /servers/:id cache entry. */
export function patchServerDetail(current: ServerDetailResponse, update: StreamServerUpdate): ServerDetailResponse {
  const server = applyUpdate(current.server, update);
  return server === current.server ? current : { ...current, server };
}

/** Whether an incident belongs in a list fetched with these filters. */
export function incidentMatches(incident: Incident, filters: IncidentFilters): boolean {
  const state = filters.state ?? 'all';
  if (state !== 'all' && incident.state !== state) return false;
  if (filters.severity !== undefined && incident.severity !== filters.severity) return false;
  if (filters.metric !== undefined && incident.metric !== filters.metric) return false;
  if (filters.server_id !== undefined && incident.server_id !== filters.server_id) return false;
  if (filters.check_id !== undefined && incident.check_id !== filters.check_id) return false;
  return true;
}

function adjustCounts(counts: IncidentCounts, previous: Incident | undefined, next: Incident): IncidentCounts {
  if (previous?.state === next.state) return counts;
  const out = { ...counts };
  if (previous?.state === 'open') out.open = Math.max(0, out.open - 1);
  if (previous?.state === 'acked') out.acked = Math.max(0, out.acked - 1);
  if (next.state === 'open') out.open += 1;
  if (next.state === 'acked') out.acked += 1;
  if (next.state === 'resolved') out.resolved_24h += 1;
  return out;
}

const byNewest = (a: Incident, b: Incident): number => b.id - a.id;

/**
 * Applies an incident change to one cached incidents list. `previous` is the
 * incident as it was before (from any cache), used to keep counts honest.
 */
export function patchIncidentsList(
  current: IncidentsResponse,
  filters: IncidentFilters,
  incident: Incident,
  previous: Incident | undefined,
): IncidentsResponse {
  const index = current.incidents.findIndex((item) => item.id === incident.id);
  const belongs = incidentMatches(incident, filters);
  let incidents = current.incidents;

  if (index !== -1 && belongs) {
    incidents = current.incidents.map((item) => (item.id === incident.id ? incident : item));
  } else if (index !== -1) {
    incidents = current.incidents.filter((item) => item.id !== incident.id);
  } else if (belongs && filters.before === undefined) {
    // Only the first page receives new rows; older pages are cursor-bound.
    incidents = [incident, ...current.incidents].sort(byNewest);
    if (filters.limit !== undefined) incidents = incidents.slice(0, filters.limit);
  }

  const counts = adjustCounts(current.counts, previous ?? current.incidents[index], incident);
  if (incidents === current.incidents && counts === current.counts) return current;
  return { incidents, counts };
}

/** Change in a server's open_incidents implied by an incident event. */
export function openIncidentDelta(event: IncidentStreamEvent, previous: Incident | undefined): number {
  const wasActive = previous !== undefined && previous.state !== 'resolved';
  const isActive = event.incident.state !== 'resolved';
  if (event.action === 'opened' && previous === undefined) return isActive ? 1 : 0;
  if (wasActive && !isActive) return -1;
  if (!wasActive && isActive && previous !== undefined) return 1;
  return 0;
}

/** Applies a +/- change to one server's open_incidents in the list cache. */
export function bumpOpenIncidents(current: ServersResponse, serverId: number, delta: number): ServersResponse {
  if (delta === 0) return current;
  if (!current.servers.some((server) => server.id === serverId)) return current;
  const servers = current.servers.map((server) =>
    server.id === serverId ? { ...server, open_incidents: Math.max(0, server.open_incidents + delta) } : server,
  );
  return { ...current, servers };
}

// ---------------------------------------------------------------- uptime checks

/** CheckJSON.latency_spark holds the last 30 results (docs/platform-v2.md 6.3). */
export const CHECK_SPARK_POINTS = 30;

export interface ChecksPatchResult {
  next: ChecksResponse;
  /** Ids in the stream that are not in the cache (created elsewhere). */
  unknownIds: number[];
}

const sameResult = (a: CheckResult | null, b: CheckResult | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.at === b.at &&
    a.ok === b.ok &&
    a.latency_ms === b.latency_ms &&
    a.status_code === b.status_code &&
    a.error === b.error);

const isNewerResult = (previous: CheckResult | null, next: CheckResult | null): next is CheckResult => {
  if (next === null) return false;
  if (previous === null) return true;
  const before = Date.parse(previous.at);
  const after = Date.parse(next.at);
  return Number.isFinite(after) && (!Number.isFinite(before) || after > before);
};

function applyCheckUpdate(check: Check, update: StreamCheckUpdate): Check {
  if (
    check.status === update.status &&
    check.uptime_24h === update.uptime_24h &&
    check.tls_days_left === update.tls_days_left &&
    check.maintenance === update.maintenance &&
    sameResult(check.last, update.last)
  ) {
    return check;
  }
  // The stream carries only the latest result: append it so the sparkline moves between list fetches.
  const latencySpark = isNewerResult(check.last, update.last)
    ? [...check.latency_spark, update.last.latency_ms].slice(-CHECK_SPARK_POINTS)
    : check.latency_spark;
  return {
    ...check,
    status: update.status,
    last: update.last,
    uptime_24h: update.uptime_24h,
    tls_days_left: update.tls_days_left,
    maintenance: update.maintenance,
    latency_spark: latencySpark,
  };
}

/** Merges a `checks` SSE payload into the GET /checks cache entry. */
export function patchChecksList(current: ChecksResponse, updates: readonly StreamCheckUpdate[]): ChecksPatchResult {
  const byId = new Map(updates.map((update) => [update.id, update]));
  let changed = false;
  const checks: Check[] = [];
  for (const check of current.checks) {
    const update = byId.get(check.id);
    byId.delete(check.id);
    const next = update ? applyCheckUpdate(check, update) : check;
    if (next !== check) changed = true;
    checks.push(next);
  }
  return { next: changed ? { ...current, checks } : current, unknownIds: [...byId.keys()] };
}

/** Applies a +/- change to one check's open_incidents in the list cache. */
export function bumpCheckOpenIncidents(current: ChecksResponse, checkId: number, delta: number): ChecksResponse {
  if (delta === 0 || !current.checks.some((check) => check.id === checkId)) return current;
  return {
    ...current,
    checks: current.checks.map((check) =>
      check.id === checkId ? { ...check, open_incidents: Math.max(0, check.open_incidents + delta) } : check,
    ),
  };
}

/** Replaces one check in the list cache (after a create, update or toggle). */
export function upsertCheck(current: ChecksResponse, check: Check): ChecksResponse {
  const exists = current.checks.some((item) => item.id === check.id);
  return { ...current, checks: exists ? current.checks.map((item) => (item.id === check.id ? check : item)) : [...current.checks, check] };
}
