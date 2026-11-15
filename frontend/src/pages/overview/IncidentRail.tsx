import { Link } from 'react-router-dom';

import { errorMessage } from '../../api/errors';
import type { Incident } from '../../api/types';
import { ButtonLink } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { IncidentCard } from '../../components/IncidentRow';
import { CardSkeleton } from '../../components/Skeletons';
import { StatusBadge } from '../../components/StatusBadge';
import { useToast } from '../../components/toastContext';
import { useAckIncident } from '../../hooks/api/incidents';
import { useOrg } from '../../providers/OrgProvider';

const DESKTOP_LIMIT = 6;
const MOBILE_LIMIT = 2;

export interface IncidentRailProps {
  incidents: readonly Incident[];
  resolved24h: number | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  compact: boolean;
}

/** Main.dc.html "Active incidents" rail: worst first, Ack inline, links to /alerts. */
export function IncidentRail({ incidents, resolved24h, loading, error, onRetry, compact }: IncidentRailProps) {
  const { can } = useOrg();
  const { toast } = useToast();
  const ack = useAckIncident();
  const shown = incidents.slice(0, compact ? MOBILE_LIMIT : DESKTOP_LIMIT);
  const canAck = can('member');

  const onAck = (incident: Incident) => () => {
    ack.mutate(incident.id, {
      onError: (caught) => {
        toast({ tone: 'error', title: 'Couldn’t acknowledge the incident', description: errorMessage(caught) });
      },
    });
  };

  return (
    <aside
      aria-labelledby="incidents-heading"
      className={compact ? 'flex flex-col gap-2' : 'flex min-w-[280px] max-w-[380px] flex-[1_1_300px] flex-col gap-3'}
    >
      <div className="flex items-baseline justify-between">
        <h2 id="incidents-heading" className={compact ? 'm-0 text-[15px] font-semibold' : 'm-0 text-h3 font-semibold'}>
          Active incidents{' '}
          {!loading && <span className="num font-medium text-ink-faint">{incidents.length}</span>}
        </h2>
        <Link to="/alerts" className="text-[13px]">
          {compact ? 'See all' : 'All alerts'}
        </Link>
      </div>

      {loading && (
        <>
          <CardSkeleton lines={4} />
          {!compact && <CardSkeleton lines={4} />}
        </>
      )}

      {!loading && error !== null && <ErrorState variant="widget" error={error} title="Couldn’t load incidents." onRetry={onRetry} />}

      {!loading && error === null && shown.length === 0 && (
        <EmptyState
          mood="sleep"
          dinoSize={compact ? 96 : 120}
          title="No open incidents"
          description="Nothing is over a threshold right now. Rex is napping on the rack."
          action={
            <ButtonLink size="sm" to="/alerts">
              View resolved
            </ButtonLink>
          }
          className={compact ? 'p-5' : 'p-6'}
        />
      )}

      {shown.map((incident) => (
        <IncidentCard
          key={incident.id}
          incident={incident}
          compact={compact}
          onAck={onAck(incident)}
          ackPending={ack.isPending && ack.variables === incident.id}
          canAct={canAck}
          disabledReason="Viewers can’t acknowledge incidents"
        />
      ))}

      {!compact && resolved24h !== null && (
        <div className="flex items-center gap-3 rounded-lg border border-line bg-surface-1 px-3.5 py-3">
          <StatusBadge status="healthy" variant="icon" />
          <span className="flex-1 text-[13px] text-ink-muted">
            <span className="num">{resolved24h}</span> resolved in the last 24 h
          </span>
          <Link to="/alerts" className="text-[13px]">
            View
          </Link>
        </div>
      )}
    </aside>
  );
}
