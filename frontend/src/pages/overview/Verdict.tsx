import { Link } from 'react-router-dom';

import type { Incident, ServerStatus, ServerSummary } from '../../api/types';
import { ButtonLink } from '../../components/Button';
import { Dino } from '../../components/Dino';
import { StatusBadge, StatusIcon } from '../../components/StatusBadge';
import { statusTextClass, statusTintClass } from '../../components/statusClasses';
import { RelativeTime } from '../../components/RelativeTime';
import { useNow } from '../../hooks/useNow';
import { cn } from '../../lib/cn';
import { formatAge, secondsSince } from '../../lib/format';
import { buildVerdict, verdictHeadline, type StatusCounts, type Verdict } from '../../lib/fleet';

const TILE_KEYS = ['all', 'healthy', 'warning', 'critical', 'offline'] as const;
type TileKey = (typeof TILE_KEYS)[number];

const TILE_LABELS: Record<TileKey, { full: string; short: string }> = {
  all: { full: 'Total', short: 'Total' },
  healthy: { full: 'Healthy', short: 'Healthy' },
  warning: { full: 'Warning', short: 'Warn' },
  critical: { full: 'Critical', short: 'Crit' },
  offline: { full: 'Offline', short: 'Offline' },
};

export interface StatusTilesProps {
  counts: StatusCounts;
  selected: ServerStatus | null;
  onSelect: (status: ServerStatus | null) => void;
  compact?: boolean;
}

/** Main.dc.html status tiles: count per status, pressing one filters the list. */
export function StatusTiles({ counts, selected, onSelect, compact = false }: StatusTilesProps) {
  const keys = compact ? TILE_KEYS.filter((key) => key !== 'all') : TILE_KEYS;
  return (
    <div
      role="group"
      aria-label="Filter by status"
      className={cn('grid gap-2', compact ? 'grid-cols-4' : 'flex-[1_1_560px] grid-cols-[repeat(5,minmax(96px,1fr))]')}
    >
      {keys.map((key) => {
        const pressed = key === 'all' ? selected === null : selected === key;
        // Mobile tiles stay plain cards (OverviewMobile board); only desktop tints a critical count.
        const hot = !compact && key === 'critical' && counts.critical > 0;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={pressed}
            onClick={() => {
              onSelect(key === 'all' || selected === key ? null : key);
            }}
            className={cn(
              'flex flex-col items-start rounded-lg border text-left text-ink transition-colors duration-150 ease-out',
              compact ? 'min-h-14 gap-0.5 px-2.5 py-2' : 'gap-1 px-3 py-2.5',
              pressed ? 'border-accent' : hot ? 'border-crit' : 'border-line',
              hot ? 'bg-tint-crit' : 'bg-surface-1 hover:bg-surface-2',
            )}
          >
            <span
              className={cn(
                'inline-flex items-center font-medium',
                compact ? 'gap-1 text-[11px] leading-[14px]' : 'gap-1.5 text-[12px] leading-4',
                key === 'all' ? 'text-ink-muted' : statusTextClass(key),
              )}
            >
              {key !== 'all' && <StatusIcon status={key} size={12} />}
              {compact ? TILE_LABELS[key].short : TILE_LABELS[key].full}
            </span>
            <span className={cn('num font-medium', compact ? 'text-[20px] leading-6' : 'text-[24px] leading-7')}>{counts[key]}</span>
          </button>
        );
      })}
    </div>
  );
}

function ReasonLine({ verdict, compact }: { verdict: Verdict; compact: boolean }) {
  const { worst, reason } = verdict;
  if (!worst) return null;
  const tone = statusTextClass(worst.status);
  return (
    <>
      <span className="font-medium text-ink">{worst.name}</span>
      {reason && (
        <>
          {' · '}
          {reason.subject}
          {reason.value !== null && (
            <>
              {compact ? ' ' : ' at '}
              <span className={cn('num', tone)}>{reason.value}</span>
            </>
          )}
          {!compact && reason.duration !== null && (
            <>
              {' for '}
              <span className="num">{reason.duration}</span>
            </>
          )}
        </>
      )}
    </>
  );
}

export interface VerdictLineProps {
  servers: readonly ServerSummary[];
  incidents: readonly Incident[];
  compact?: boolean;
}

/** Main.dc.html verdict: worst status shape, "1 server critical, 3 need attention", and why. */
export function VerdictLine({ servers, incidents, compact = false }: VerdictLineProps) {
  const now = useNow();
  const verdict = buildVerdict(servers, incidents, now);
  const status: ServerStatus = verdict.worst?.status ?? 'warning';
  const { primary, secondary } = verdictHeadline(verdict);

  if (compact) {
    const content = (
      <>
        <span className={cn('inline-flex h-9 w-9 flex-none items-center justify-center rounded-lg', statusTintClass(status), statusTextClass(status))}>
          <StatusIcon status={status} size={20} strokeWidth={1.5} />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[16px] font-semibold">
            {primary.replace(/ servers? /, ' ')}
            {secondary && ` · ${secondary}`}
          </span>
          <span className="truncate text-[13px] text-ink-muted">
            <ReasonLine verdict={verdict} compact />
          </span>
        </span>
      </>
    );
    const classes = cn(
      'flex items-center gap-3 rounded-lg border p-3.5 text-ink no-underline hover:text-ink',
      status === 'critical' ? 'border-crit bg-tint-crit' : status === 'offline' ? 'border-off bg-tint-off' : 'border-warn bg-tint-warn',
    );
    return verdict.worst ? (
      <Link to={`/servers/${verdict.worst.id}`} className={classes}>
        {content}
      </Link>
    ) : (
      <div className={classes}>{content}</div>
    );
  }

  return (
    <div className="flex min-w-0 flex-[1_1_420px] items-center gap-3.5">
      <span className={cn('inline-flex h-11 w-11 flex-none items-center justify-center rounded-[10px]', statusTintClass(status), statusTextClass(status))}>
        <StatusIcon status={status} size={24} strokeWidth={1.5} />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 id="verdict" className="m-0 text-h1 font-semibold tracking-[-0.005em]">
          {primary}
          {secondary && <span className="font-medium text-ink-muted">, {secondary}</span>}
        </h2>
        {verdict.worst && (
          <Link to={`/servers/${verdict.worst.id}`} className="truncate text-[13px] leading-4 text-ink-muted no-underline hover:text-ink">
            <ReasonLine verdict={verdict} compact={false} /> →
          </Link>
        )}
      </div>
    </div>
  );
}

export interface HealthyCardProps {
  total: number;
  lastResolved: Incident | null;
  updatedAt: number | null;
  compact?: boolean;
}

/** States.dc.html "All systems healthy": replaces the verdict when nothing needs action. */
export function HealthyCard({ total, lastResolved, updatedAt, compact = false }: HealthyCardProps) {
  const now = useNow();
  const resolvedAgo = lastResolved ? secondsSince(lastResolved.resolved_at, now) : null;
  return (
    <section
      aria-labelledby="verdict"
      className={cn('flex items-center rounded-lg border border-ok bg-surface-1', compact ? 'flex-col gap-3 p-5 text-center' : 'gap-6 p-7')}
    >
      <Dino mood="happy" size={compact ? 110 : 150} beatTone="ok" label="" />
      <div className={cn('flex flex-col gap-1.5', compact && 'items-center')}>
        <h2 id="verdict" className={cn('m-0 flex items-center gap-2.5 font-semibold', compact ? 'text-h2' : 'text-h1')}>
          <StatusBadge status="healthy" variant="icon" />
          {total === 1 ? 'Your server is healthy' : `All ${total} servers healthy`}
        </h2>
        <p className="m-0 text-ink-muted">
          Nothing’s on fire.
          {lastResolved && resolvedAgo !== null && (
            <>
              {' '}
              Last incident resolved {formatAge(resolvedAgo)} ago on {lastResolved.server_name}.
            </>
          )}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <ButtonLink size="sm" to="/alerts">
            Recent incidents
          </ButtonLink>
          {updatedAt !== null && <RelativeTime value={updatedAt} prefix="updated " className="text-[12px] text-ink-faint" />}
        </div>
      </div>
    </section>
  );
}
