/** Incident timing and value helpers shared by IncidentRow, IncidentCard and the Alerts page. */
import type { Incident } from '../api/types';

import { formatAge, formatDuration, secondsSince, toTime } from './format';
import { formatMetricValue, formatThreshold } from './status';

/** Seconds the incident has lasted (until now while open). */
export function incidentDurationSeconds(incident: Incident, now: number): number {
  const end = incident.resolved_at ? (toTime(incident.resolved_at) ?? now) : now;
  return secondsSince(incident.started_at, end) ?? 0;
}

/** "94.6%", or for heartbeat incidents "12m silent". */
export function incidentPeak(incident: Incident, now: number): string {
  if (incident.metric === 'heartbeat') return `${formatDuration(incidentDurationSeconds(incident, now), 1)} silent`;
  return formatMetricValue(incident.peak, incident.unit);
}

export function incidentThreshold(incident: Incident): string | null {
  return incident.metric === 'heartbeat' ? null : formatThreshold(incident.threshold, incident.unit);
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
