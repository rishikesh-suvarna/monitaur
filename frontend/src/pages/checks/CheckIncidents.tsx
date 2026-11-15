import { Link } from 'react-router-dom';

import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { IncidentRow } from '../../components/IncidentRow';
import { TableRowsSkeleton } from '../../components/Skeletons';
import { useIncidentPages } from '../../hooks/api/incidentPages';
import { useIncidentActions } from '../../hooks/useIncidentActions';
import { incidentCheckId } from '../../lib/incidents';

/** Alerts filtered to uptime check incidents. */
export const UPTIME_ALERTS_PATH = '/alerts?state=all&type=uptime';

/**
 * The check's incidents, newest first, with Acknowledge and Resolve. Rows are
 * also filtered locally: docs/platform-v2.md only documents `server_id` as a
 * GET /incidents filter, so `check_id` may be ignored by the backend.
 */
export function CheckIncidents({ checkId, compact }: { checkId: number; compact: boolean }) {
  const actions = useIncidentActions();
  const pages = useIncidentPages({ check_id: checkId, state: 'all' });
  const incidents = pages.incidents.filter((incident) => incidentCheckId(incident) === checkId);

  let body;
  if (pages.isPending) {
    body = <TableRowsSkeleton rows={3} />;
  } else if (pages.error && incidents.length === 0) {
    body = (
      <div className="p-4">
        <ErrorState variant="widget" error={pages.error} title="Couldn’t load this check’s incidents." onRetry={pages.refetch} retrying={pages.isFetching} />
      </div>
    );
  } else if (incidents.length === 0) {
    body = (
      <EmptyState
        variant="plain"
        mood="sleep"
        dinoSize={96}
        title="No incidents yet"
        description="Two failed results in a row open one here; a certificate close to expiry opens a warning."
        className="py-8"
      />
    );
  } else {
    body = incidents.map((incident) => (
      <IncidentRow
        key={incident.id}
        incident={incident}
        compact={compact}
        onAck={() => {
          actions.ack(incident);
        }}
        onResolve={() => {
          actions.resolve(incident);
        }}
        ackPending={actions.isAcking(incident.id)}
        resolvePending={actions.isResolving(incident.id)}
        canAct={actions.canAct}
        disabledReason={actions.disabledReason}
      />
    ));
  }

  return (
    <Card as="section" aria-labelledby="check-incidents-heading" className="overflow-hidden [&>div:last-child]:border-b-0">
      <div className="flex items-baseline justify-between border-b border-line px-4 pb-3 pt-4">
        <h2 id="check-incidents-heading" className="m-0 text-h3 font-semibold">
          Incidents
        </h2>
        <Link to={UPTIME_ALERTS_PATH} className="text-[13px]">
          All uptime alerts
        </Link>
      </div>
      {body}
      {pages.hasMore && (
        <div className="flex justify-center border-t border-line p-3">
          <Button size="sm" onClick={pages.loadMore} loading={pages.loadingMore}>
            Load older incidents
          </Button>
        </div>
      )}
    </Card>
  );
}
