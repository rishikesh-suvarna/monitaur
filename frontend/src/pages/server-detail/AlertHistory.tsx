import { Link } from 'react-router-dom';

import type { Incident } from '../../api/types';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { TableRowsSkeleton } from '../../components/Skeletons';
import { StatusBadge } from '../../components/StatusBadge';
import { useIncidentPages } from '../../hooks/api/incidentPages';
import { useIncidentActions, type IncidentActions } from '../../hooks/useIncidentActions';
import { useNow } from '../../hooks/useNow';
import { cn } from '../../lib/cn';
import { formatDayTime } from '../../lib/format';
import { incidentDurationLabel, incidentPeak, incidentThreshold, resolvedHowLabel } from '../../lib/incidents';
import { incidentTitle, presentIncident } from '../../lib/status';

import { alertsForServer } from './routes';

const RECENT_LIMIT = 5;
const PEAK_TONE = { crit: 'text-crit', warn: 'text-warn', off: 'text-off', resolved: 'text-ink' } as const;

export interface AlertHistoryProps {
  serverId: number;
  /** recent: the five newest under the charts; full: the Alerts tab, with "Load older". */
  mode: 'recent' | 'full';
  compact: boolean;
}

function Actions({ incident, actions, size }: { incident: Incident; actions: IncidentActions; size: 'sm' | 'touch' }) {
  if (incident.state === 'resolved') return <span className="text-[12px] text-ink-faint">{resolvedHowLabel(incident)}</span>;
  const title = actions.canAct ? undefined : actions.disabledReason;
  const touch = size === 'touch' ? 'h-9' : undefined;
  return (
    <span className="inline-flex flex-wrap gap-2">
      {incident.state === 'open' ? (
        <Button
          size="sm"
          className={touch}
          onClick={() => {
            actions.ack(incident);
          }}
          loading={actions.isAcking(incident.id)}
          disabled={!actions.canAct}
          title={title}
        >
          Acknowledge
        </Button>
      ) : (
        <span className="inline-flex h-7 items-center text-[12px] text-ink-faint">Acknowledged</span>
      )}
      <Button
        size="sm"
        variant="ghost"
        className={touch}
        onClick={() => {
          actions.resolve(incident);
        }}
        loading={actions.isResolving(incident.id)}
        disabled={!actions.canAct}
        title={title}
      >
        Resolve
      </Button>
    </span>
  );
}

function HistoryRow({ incident, actions }: { incident: Incident; actions: IncidentActions }) {
  const now = useNow();
  const look = presentIncident(incident);
  const threshold = incidentThreshold(incident);
  return (
    <tr className="border-t border-line transition-colors duration-150 ease-out hover:bg-surface-2">
      <td className="px-4 py-2.5">
        <StatusBadge status={look.status} size="sm" text={look.label} />
      </td>
      <td className="px-2 py-2.5 font-medium">
        {incidentTitle(incident)}
        {incident.rule_name !== '' && <span className="ml-2 text-[12px] font-normal text-ink-faint">{incident.rule_name}</span>}
      </td>
      <td className="num px-2 py-2.5 text-ink-muted">{formatDayTime(incident.started_at, now)}</td>
      <td className="num px-2 py-2.5 text-ink-muted">{incidentDurationLabel(incident, now)}</td>
      <td className="num px-2 py-2.5">
        <span className={PEAK_TONE[look.bar]}>{incidentPeak(incident, now)}</span>
        {threshold && <span className="text-ink-faint"> / {threshold}</span>}
      </td>
      <td className="px-4 py-2.5 text-right">
        <Actions incident={incident} actions={actions} size="sm" />
      </td>
    </tr>
  );
}

function HistoryCard({ incident, actions }: { incident: Incident; actions: IncidentActions }) {
  const now = useNow();
  const look = presentIncident(incident);
  const threshold = incidentThreshold(incident);
  const lasted = incidentDurationLabel(incident, now);
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface-1 p-3">
      <div className="flex items-center gap-2">
        <StatusBadge status={look.status} size="sm" text={look.label} />
        <span className="num ml-auto text-[12px] text-ink-faint">{formatDayTime(incident.started_at, now)}</span>
      </div>
      <span className="text-[13px] font-semibold">{incidentTitle(incident)}</span>
      <span className="num text-[12px] text-ink-muted">
        {lasted} · peak {incidentPeak(incident, now)}
        {threshold && ` / ${threshold}`}
      </span>
      {incident.state !== 'resolved' && (
        <div className="pt-1">
          <Actions incident={incident} actions={actions} size="touch" />
        </div>
      )}
    </li>
  );
}

/**
 * ServerDetail.dc.html "Alert history": this server's incidents from GET
 * /incidents?server_id=, newest active first, with Acknowledge and Resolve.
 */
export function AlertHistory({ serverId, mode, compact }: AlertHistoryProps) {
  const actions = useIncidentActions();
  const pages = useIncidentPages({ server_id: serverId, state: 'all' }, mode === 'recent' ? { pageSize: RECENT_LIMIT } : {});
  const headingId = `alert-history-${mode}`;
  const link = (
    <Link to={alertsForServer(serverId)} className="text-[13px]">
      Open in Alerts
    </Link>
  );

  let body;
  if (pages.isPending) {
    body = <TableRowsSkeleton rows={4} />;
  } else if (pages.error && pages.incidents.length === 0) {
    body = (
      <div className={compact ? undefined : 'px-4 pb-4'}>
        <ErrorState variant="widget" error={pages.error} title="Couldn’t load this server’s alert history." onRetry={pages.refetch} retrying={pages.isFetching} />
      </div>
    );
  } else if (pages.incidents.length === 0) {
    body = (
      <EmptyState
        variant="plain"
        mood="sleep"
        dinoSize={96}
        title="No alerts yet"
        description="Nothing on this server has crossed a rule. Incidents show up here as they open."
        className="py-8"
      />
    );
  } else if (compact) {
    body = (
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {pages.incidents.map((incident) => (
          <HistoryCard key={incident.id} incident={incident} actions={actions} />
        ))}
      </ul>
    );
  } else {
    body = (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse text-[13px]">
          <caption className="sr-only">Incidents on this server, newest active first</caption>
          <thead>
            <tr className="cap bg-surface-2 text-left">
              <th scope="col" className="px-4 py-2.5 font-medium">
                Severity
              </th>
              <th scope="col" className="px-2 py-2.5 font-medium">
                Rule
              </th>
              <th scope="col" className="px-2 py-2.5 font-medium">
                Started
              </th>
              <th scope="col" className="px-2 py-2.5 font-medium">
                Duration
              </th>
              <th scope="col" className="px-2 py-2.5 font-medium">
                Peak / threshold
              </th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium">
                State
              </th>
            </tr>
          </thead>
          <tbody>
            {pages.incidents.map((incident) => (
              <HistoryRow key={incident.id} incident={incident} actions={actions} />
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const more =
    mode === 'full' && pages.hasMore ? (
      <div className={cn('flex justify-center', compact ? 'pt-1' : 'border-t border-line p-3')}>
        <Button size="sm" onClick={pages.loadMore} loading={pages.loadingMore}>
          Load older incidents
        </Button>
      </div>
    ) : null;

  if (compact) {
    return (
      <section aria-labelledby={headingId} className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h2 id={headingId} className="m-0 text-[15px] font-semibold">
            Alert history
          </h2>
          {link}
        </div>
        {body}
        {more}
      </section>
    );
  }

  return (
    <Card as="section" aria-labelledby={headingId} className="overflow-hidden">
      <div className="flex items-baseline justify-between px-4 pb-3 pt-4">
        <h2 id={headingId} className="m-0 text-h3 font-semibold">
          Alert history
        </h2>
        {link}
      </div>
      {body}
      {more}
    </Card>
  );
}
