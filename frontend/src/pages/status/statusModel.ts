/**
 * Public status page shaping (StatusPage.dc.html): the 90-day uptime bar, the
 * overall verdict line and incident cards. Pure, unit tested.
 */
import type { PublicServiceKind, PublicStatusDay, PublicStatusIncident, PublicStatusService, ServerStatus } from '../../api/types';
import { checkBadgeStatus, isCheckMetric, isCheckStatus } from '../../lib/checks';
import { EMPTY_VALUE, formatDayTime, formatDuration, toTime } from '../../lib/format';
import { METRIC_LABELS, SERVER_STATUSES } from '../../lib/status';

export const UPTIME_DAYS = 90;
const MS_PER_DAY = 86_400_000;
const MS_PER_SECOND = 1000;
const PERCENT_MAX = 100;
const UPTIME_DECIMALS = 2;

/** Public wording for each status (the design's legend). */
export const STATUS_WORD: Record<ServerStatus, string> = {
  healthy: 'Operational',
  warning: 'Degraded',
  critical: 'Outage',
  offline: 'Offline',
};

// ---------------------------------------------------------------- services

/** A service ready to draw: server vocabulary for the status, and a kind even from older backends. */
export interface StatusService extends Omit<PublicStatusService, 'status' | 'kind'> {
  status: ServerStatus;
  kind: PublicServiceKind;
}

const isServerStatus = (value: string): value is ServerStatus => (SERVER_STATUSES as readonly string[]).includes(value);

/**
 * docs/platform-v2.md 6.3 does not say which words a check service sends:
 * server words pass through, check words (up, down, ...) map onto their
 * badge shape, anything else reads as offline.
 */
export function serviceStatus(status: string): ServerStatus {
  if (isServerStatus(status)) return status;
  if (isCheckStatus(status)) return checkBadgeStatus(status);
  return 'offline';
}

export function normalizeService(service: PublicStatusService): StatusService {
  return { ...service, status: serviceStatus(service.status), kind: service.kind ?? 'server' };
}

export const SERVICE_KIND_LABEL: Record<PublicServiceKind, string> = { server: 'Server', check: 'Uptime check' };

export type DayKind = 'ok' | 'warn' | 'crit' | 'none';

/** Bar height per kind, so status reads without colour too (StatusPage.dc.html). */
export const DAY_HEIGHT_PCT: Record<DayKind, number> = { ok: 100, warn: 70, crit: 45, none: 25 };

export const DAY_KIND_LABEL: Record<DayKind, string> = {
  ok: 'Operational',
  warn: 'Degraded',
  crit: 'Outage',
  none: 'No data',
};

export interface UptimeCell {
  day: string;
  kind: DayKind;
  heightPct: number;
  /** Tooltip: "Nov 3 · 99.21% up · degraded". */
  label: string;
}

const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

const formatDay = (day: string): string => {
  const time = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(time) ? dayFormat.format(time) : day;
};

/** "100%", "99.98%": never rounds up to 100. */
export function formatUptime(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return EMPTY_VALUE;
  if (pct >= PERCENT_MAX) return '100%';
  const factor = 10 ** UPTIME_DECIMALS;
  return `${(Math.floor(Math.max(0, pct) * factor) / factor).toFixed(UPTIME_DECIMALS)}%`;
}

export function dayKind(day: Pick<PublicStatusDay, 'pct' | 'worst'>): DayKind {
  if (day.pct === null) return 'none';
  if (day.worst === 'critical') return 'crit';
  if (day.worst === 'warning') return 'warn';
  return 'ok';
}

const shiftDay = (day: string, deltaDays: number): string => {
  const time = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(time)) return day;
  return new Date(time + deltaDays * MS_PER_DAY).toISOString().slice(0, 10);
};

/**
 * Exactly `count` cells, oldest first. Extra days are dropped from the old
 * end; missing ones are padded there as "no data", so today is always last.
 */
export function shapeUptimeDays(days: readonly PublicStatusDay[], count = UPTIME_DAYS): UptimeCell[] {
  const recent = days.slice(-count);
  const first = recent[0]?.day ?? new Date().toISOString().slice(0, 10);
  const padding: PublicStatusDay[] = Array.from({ length: count - recent.length }, (_, index) => ({
    day: shiftDay(first, index - (count - recent.length)),
    pct: null,
    worst: null,
  }));
  return [...padding, ...recent].map((day) => {
    const kind = dayKind(day);
    const parts = [formatDay(day.day), day.pct === null ? 'No data' : `${formatUptime(day.pct)} up`];
    if (kind === 'warn' || kind === 'crit') parts.push(DAY_KIND_LABEL[kind].toLowerCase());
    return { day: day.day, kind, heightPct: DAY_HEIGHT_PCT[kind], label: parts.join(' · ') };
  });
}

/** Screen-reader summary of one service's bar. */
export function uptimeSummary(service: Pick<StatusService, 'name' | 'uptime_pct' | 'status'>, cells: readonly UptimeCell[]): string {
  const incidentDays = cells.filter((cell) => cell.kind === 'warn' || cell.kind === 'crit').length;
  const days = incidentDays === 0 ? 'no days with incidents' : incidentDays === 1 ? '1 day with incidents' : `${incidentDays} days with incidents`;
  return `${service.name}: ${formatUptime(service.uptime_pct)} uptime over ${UPTIME_DAYS} days, ${days}, currently ${STATUS_WORD[service.status].toLowerCase()}.`;
}

// ---------------------------------------------------------------- verdict

const STATE_PHRASE: Record<Exclude<ServerStatus, 'healthy'>, { one: string; many: string }> = {
  critical: { one: 'is having an outage', many: 'are having an outage' },
  warning: { one: 'is degraded', many: 'are degraded' },
  offline: { one: 'is offline', many: 'are offline' },
};
const VERDICT_ORDER: readonly Exclude<ServerStatus, 'healthy'>[] = ['critical', 'warning', 'offline'];

const joinNames = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;

/** "Database is degraded; everything else is operational", "All systems operational". */
export function statusVerdict(services: readonly Pick<StatusService, 'name' | 'status'>[]): string {
  if (services.length === 0) return 'No services are listed on this page yet.';
  const parts = VERDICT_ORDER.flatMap((status) => {
    const names = services.filter((service) => service.status === status).map((service) => service.name);
    if (names.length === 0) return [];
    return [`${joinNames(names)} ${names.length === 1 ? STATE_PHRASE[status].one : STATE_PHRASE[status].many}`];
  });
  if (parts.length === 0) return services.length === 1 ? `${services[0]?.name ?? 'Everything'} is operational` : 'All systems operational';
  const healthy = services.some((service) => service.status === 'healthy');
  // Server names keep their own case, so the sentence is not capitalised.
  return `${parts.join(' and ')}${healthy ? '; everything else is operational' : ''}`;
}

// ---------------------------------------------------------------- incidents

export interface IncidentView {
  status: ServerStatus;
  badge: string;
  title: string;
  when: string;
  body: string;
}

/** "Unreachable", "Down", "Certificate expiring", "CPU critical". */
function publicIncidentWhat(incident: Pick<PublicStatusIncident, 'metric' | 'severity'>): string {
  if (incident.metric === 'heartbeat') return 'Unreachable';
  if (incident.metric === 'tls_expiry') return 'Certificate expiring';
  if (isCheckMetric(incident.metric)) return 'Down';
  return `${METRIC_LABELS[incident.metric]} ${incident.severity}`;
}

export function incidentView(incident: PublicStatusIncident, now: number): IncidentView {
  const start = toTime(incident.started_at) ?? now;
  const end = toTime(incident.resolved_at);
  const resolved = end !== null;
  const started = formatDayTime(start, now);
  const length = formatDuration(((end ?? now) - start) / MS_PER_SECOND);
  let status: ServerStatus = 'healthy';
  if (!resolved) {
    if (incident.metric === 'heartbeat') status = 'offline';
    else if (isCheckMetric(incident.metric) && incident.metric !== 'tls_expiry') status = 'critical';
    else status = incident.severity === 'critical' ? 'critical' : 'warning';
  }
  return {
    status,
    badge: resolved ? 'Resolved' : 'Ongoing',
    title: `${incident.service}: ${publicIncidentWhat(incident)}`,
    when: resolved ? `${started} · ${length}` : `${started} · ongoing`,
    body: resolved ? `Started ${started} and resolved after ${length}.` : `Started ${started}; ongoing for ${length}.`,
  };
}

/** "Acme status", but not "Acme Status status". */
export function pageHeading(title: string): string {
  return /\bstatus\b/i.test(title) ? title : `${title} status`;
}
