import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { Incident } from '../../api/types';
import { useNow } from '../../hooks/useNow';
import { formatClock, formatDayTime } from '../../lib/format';
import { incidentDurationLabel, incidentPeak, incidentThreshold, nextNotifyLabel, resolvedHowLabel } from '../../lib/incidents';
import { ruleEditPath } from '../server-settings/ruleScope';

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-faint">{term}</dt>
      <dd className="m-0 min-w-0 text-ink">{children}</dd>
    </>
  );
}

/**
 * Alerts.dc.html expanded row: samples over, the rule, who was notified, the
 * next reminder (cooldown), peak against threshold, when it started and how
 * long it has lasted (ticking while active).
 */
export function IncidentDetails({ incident }: { incident: Incident }) {
  const now = useNow();
  const threshold = incidentThreshold(incident);
  return (
    <dl className="num m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[12px] md:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
      <Row term="Samples over">{incident.samples_over.toLocaleString()}</Row>
      <Row term="Rule">
        {incident.rule_id === null ? (
          <span className="text-ink-muted">{incident.rule_name || 'Deleted rule'}</span>
        ) : (
          <Link to={ruleEditPath(incident.rule_id)}>{incident.rule_name || `Rule ${incident.rule_id}`}</Link>
        )}
      </Row>
      <Row term="Peak / threshold">
        {incidentPeak(incident, now)}
        {threshold && (
          <span className="text-ink-muted">
            {' '}
            / {incident.comparison} {threshold}
          </span>
        )}
      </Row>
      <Row term="Notified">{incident.notified_channels.length > 0 ? incident.notified_channels.join(', ') : 'nobody yet'}</Row>
      <Row term="Started">
        <time dateTime={incident.started_at} title={formatClock(incident.started_at)}>
          {formatDayTime(incident.started_at, now)}
        </time>
      </Row>
      <Row term="Next notify">{nextNotifyLabel(incident, now)}</Row>
      <Row term="Duration">{incidentDurationLabel(incident, now)}</Row>
      {incident.state === 'acked' && (
        <Row term="Acknowledged">
          {incident.acked_by ?? 'someone'}
          {incident.acked_at && ` · ${formatDayTime(incident.acked_at, now)}`}
        </Row>
      )}
      {incident.state === 'resolved' && (
        <Row term="Resolved">
          {resolvedHowLabel(incident)}
          {incident.resolved_at && ` · ${formatDayTime(incident.resolved_at, now)}`}
        </Row>
      )}
    </dl>
  );
}
