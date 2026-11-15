/** Incident timing and value helpers shared by IncidentRow, IncidentCard and the Alerts page. */
import type { Incident } from '../api/types';

import { isCheckMetric } from './checks';
import { formatAge, formatDuration, secondsSince, toTime } from './format';
import { formatMetricValue, formatThreshold } from './status';

/** Seconds the incident has lasted (until now while open). */
export function incidentDurationSeconds(incident: Incident, now: number): number {
  const end = incident.resolved_at ? (toTime(incident.resolved_at) ?? now) : now;
  return secondsSince(incident.started_at, end) ?? 0;
}

/** "94.6%", for heartbeat incidents "12m silent", for failing checks "4m down", for certificates "9 d left". */
export function incidentPeak(incident: Incident, now: number): string {
  if (incident.metric === 'heartbeat') return `${formatDuration(incidentDurationSeconds(incident, now), 1)} silent`;
  if (incident.metric === 'tls_expiry') return `${Math.max(0, Math.floor(incident.last_value))} d left`;
  if (isCheckMetric(incident.metric)) return `${formatDuration(incidentDurationSeconds(incident, now), 1)} down`;
  return formatMetricValue(incident.peak, incident.unit);
}

export function incidentThreshold(incident: Incident): string | null {
  if (incident.metric === 'tls_expiry') return `${Math.floor(incident.threshold)} d`;
  return incident.metric === 'heartbeat' || isCheckMetric(incident.metric) ? null : formatThreshold(incident.threshold, incident.unit);
}

/** Whether a peak-against-threshold meter means anything (not for heartbeats or uptime checks). */
export function hasValueMeter(incident: Pick<Incident, 'metric'>): boolean {
  return incident.metric !== 'heartbeat' && !isCheckMetric(incident.metric);
}

/** What the incident is about: the server, or the uptime check (F7). */
export interface IncidentSubject {
  kind: 'server' | 'check';
  id: number | null;
  name: string;
}

/** The incident's check id, or null (also for payloads from backends that predate checks). */
export function incidentCheckId(incident: Pick<Incident, 'check_id'>): number | null {
  return typeof incident.check_id === 'number' ? incident.check_id : null;
}

export function incidentSubject(incident: Pick<Incident, 'server_id' | 'server_name' | 'check_id' | 'check_name'>): IncidentSubject {
  const checkId = incidentCheckId(incident);
  if (checkId !== null) return { kind: 'check', id: checkId, name: incident.check_name ?? incident.server_name };
  return { kind: 'server', id: incident.server_id, name: incident.server_name };
}

/** How an incident was closed (alerting.ResolveHow), in words. */
export const RESOLVED_HOW: Record<string, string> = {
  auto: 'Auto-resolved',
  manual: 'Resolved manually',
  server_deleted: 'Server deleted',
  rule_changed: 'Rule changed',
};

export function resolvedHowLabel(incident: Pick<Incident, 'resolved_how'>): string {
  return RESOLVED_HOW[incident.resolved_how ?? ''] ?? 'Resolved';
}

/** "23m 10s · open", "4m 30s": ticks with `now` while the incident is active. */
export function incidentDurationLabel(incident: Incident, now: number): string {
  const lasted = formatDuration(incidentDurationSeconds(incident, now));
  return incident.state === 'resolved' ? lasted : `${lasted} · ${incident.state === 'acked' ? 'acked' : 'open'}`;
}

/**
 * Alerts.dc.html "Next notify": the cooldown until the next reminder while
 * open; acknowledging or resolving stops reminders.
 */
export function nextNotifyLabel(incident: Pick<Incident, 'state' | 'next_notify_at'>, now: number): string {
  if (incident.state === 'resolved') return 'none, resolved';
  if (incident.state === 'acked') return 'paused while acknowledged';
  const at = toTime(incident.next_notify_at);
  if (at === null) return 'no reminders';
  const seconds = (at - now) / 1000;
  return seconds <= 0 ? 'due now' : `cooldown, ${formatAge(seconds)}`;
}
