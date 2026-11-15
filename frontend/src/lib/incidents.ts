/** Incident timing and value helpers shared by IncidentRow, IncidentCard and the Alerts page. */
import type { Incident } from '../api/types';

import { formatDuration, secondsSince, toTime } from './format';
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
