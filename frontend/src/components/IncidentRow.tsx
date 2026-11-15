import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { Incident } from '../api/types';
import { useNow } from '../hooks/useNow';
import { cn } from '../lib/cn';
import { formatDayTime, formatDuration, toTime } from '../lib/format';
import { incidentDurationSeconds, incidentPeak, incidentThreshold } from '../lib/incidents';
import { incidentTitle, presentIncident } from '../lib/status';

import { Button } from './Button';
import { Chip } from './Chip';
import { IconButton } from './IconButton';
import { serverPath } from './serverMetrics';
import { StatusBadge } from './StatusBadge';

const BAR_CLASS = { crit: 'bg-crit', warn: 'bg-warn', off: 'bg-off', resolved: 'bg-line-strong' } as const;
const LEFT_BORDER = { crit: 'border-l-crit', warn: 'border-l-warn', off: 'border-l-off', resolved: 'border-l-line-strong' } as const;
const PEAK_TEXT_CLASS = { crit: 'text-crit', warn: 'text-warn', off: 'text-off', resolved: 'text-ink-muted' } as const;
const PERCENT_SCALE = 100;
const RATE_HEADROOM = 1.2;

const RESOLVED_HOW: Record<string, string> = {
  auto: 'Auto-resolved',
  manual: 'Resolved manually',
  server_deleted: 'Server deleted',
  rule_changed: 'Rule changed',
};

function ackedLabel(incident: Incident): string {
  const time = toTime(incident.acked_at);
  const when = time === null ? '' : ` ${new Date(time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`;
  return incident.acked_by ? `Acked · ${incident.acked_by}${when}` : 'Acked';
}

export interface IncidentActionsProps {
  onAck?: () => void;
  onResolve?: () => void;
  ackPending?: boolean;
  resolvePending?: boolean;
  /** False for viewers: actions stay visible but disabled, with a reason. */
  canAct?: boolean;
  disabledReason?: string;
}

export interface IncidentRowProps extends IncidentActionsProps {
  incident: Incident;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  /** Rendered under the row when expanded (samples chart, rule, next notify). */
  details?: ReactNode;
  /** Mobile layout: meter and actions wrap under the text. */
  compact?: boolean;
}

/**
 * Alerts.dc.html incident row: severity bar, badge + title, server and
 * timings, peak vs threshold meter, and Acknowledge / Resolve. One row per
 * incident, not per sample.
 */
export function IncidentRow({
  incident,
  onAck,
  onResolve,
  ackPending = false,
  resolvePending = false,
  canAct = true,
  disabledReason = 'Your role cannot change incidents',
  expanded = false,
  onToggleExpanded,
  details,
  compact = false,
}: IncidentRowProps) {
  const now = useNow();
  const look = presentIncident(incident);
  const open = incident.state !== 'resolved';
  const threshold = incidentThreshold(incident);
  const scale =
    incident.unit === '%' ? PERCENT_SCALE : Math.max(incident.peak, incident.threshold) * RATE_HEADROOM || PERCENT_SCALE;
  const meter = incident.metric !== 'heartbeat';
  const lasted = formatDuration(incidentDurationSeconds(incident, now));
  const actionTitle = canAct ? undefined : disabledReason;

  return (
    <div className="border-b border-line">
      <div
        className={cn(
          'grid items-center gap-x-4 gap-y-3 py-3 pr-4 transition-colors duration-150 ease-out hover:bg-surface-2',
          compact ? 'grid-cols-[4px_minmax(0,1fr)]' : 'grid-cols-[4px_minmax(0,1fr)_200px_auto]',
        )}
      >
        <span aria-hidden="true" className={cn('self-stretch rounded-r-sm', BAR_CLASS[look.bar])} />
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={look.status} size="sm" text={look.label} />
            <span className="font-semibold">{incidentTitle(incident)}</span>
            {incident.state === 'acked' && <Chip>{ackedLabel(incident)}</Chip>}
          </div>
          <div className="flex flex-wrap gap-x-3.5 gap-y-1.5 text-[12px] text-ink-muted">
            <Link to={serverPath(incident.server_id)} className="font-medium">
              {incident.server_name}
            </Link>
            <span className="num">started {formatDayTime(incident.started_at, now)}</span>
            <span className="num">
              lasted {lasted}
              {open ? ' (open)' : ''}
            </span>
            {incident.notified_channels.length > 0 && <span>notified {incident.notified_channels.join(', ')}</span>}
          </div>
        </div>
        <div className={cn('flex min-w-0 flex-col gap-1', compact && 'col-start-2')}>
          <div className="num text-[12px] text-ink-muted">
            peak <span className={cn('font-semibold', PEAK_TEXT_CLASS[look.bar])}>{incidentPeak(incident, now)}</span>
            {threshold && <> / {threshold}</>}
          </div>
          {meter && (
            <div aria-hidden="true" className="relative h-1.5 rounded-[3px] bg-surface-3">
              <span
                className={cn('absolute inset-y-0 left-0 rounded-[3px]', open ? BAR_CLASS[look.bar] : 'bg-ink-muted')}
                style={{ width: `${Math.min(100, (incident.peak / scale) * 100)}%` }}
              />
              <span
                className="absolute -bottom-[3px] -top-[3px] border-l-2 border-ink"
                style={{ left: `${Math.min(100, (incident.threshold / scale) * 100)}%` }}
              />
            </div>
          )}
        </div>
        <div className={cn('flex flex-wrap gap-2', compact ? 'col-start-2 justify-start' : 'justify-end')}>
          {open && incident.state === 'open' && onAck && (
            <Button size="sm" className={compact ? 'h-9' : undefined} onClick={onAck} loading={ackPending} disabled={!canAct} title={actionTitle}>
              Acknowledge
            </Button>
          )}
          {open && onResolve && (
            <Button
              size="sm"
              variant="ghost"
              className={compact ? 'h-9' : undefined}
              onClick={onResolve}
              loading={resolvePending}
              disabled={!canAct}
              title={actionTitle}
            >
              Resolve
            </Button>
          )}
          {!open && <span className="text-[12px] text-ink-faint">{RESOLVED_HOW[incident.resolved_how ?? ''] ?? 'Resolved'}</span>}
          {onToggleExpanded && (
            <IconButton
              size="sm"
              aria-label={expanded ? 'Hide samples' : 'Show samples'}
              aria-expanded={expanded}
              onClick={onToggleExpanded}
              icon={expanded ? <ChevronDownIcon className="h-3.5 w-3.5" strokeWidth={2} /> : <ChevronRightIcon className="h-3.5 w-3.5" strokeWidth={2} />}
              className={cn('w-7', compact && 'h-9')}
            />
          )}
        </div>
      </div>
      {expanded && details && <div className="px-4 pb-4 pl-5 pt-1">{details}</div>}
    </div>
  );
}

export interface IncidentCardProps extends IncidentActionsProps {
  incident: Incident;
  /** Mobile rail: title, server and duration on two lines with a 36 px Ack. */
  compact?: boolean;
}

/** Main.dc.html "Active incidents" rail card. */
export function IncidentCard({
  incident,
  onAck,
  ackPending = false,
  canAct = true,
  disabledReason = 'Your role cannot acknowledge incidents',
  compact = false,
}: IncidentCardProps) {
  const now = useNow();
  const look = presentIncident(incident);
  const threshold = incidentThreshold(incident);
  const duration = formatDuration(incidentDurationSeconds(incident, now), 1);
  const acked = incident.state === 'acked';
  const ack =
    !acked && onAck ? (
      <Button
        size="sm"
        className={compact ? 'h-9' : undefined}
        onClick={onAck}
        loading={ackPending}
        disabled={!canAct}
        title={canAct ? undefined : disabledReason}
        aria-label={`Acknowledge ${incidentTitle(incident)} on ${incident.server_name}`}
      >
        Ack
      </Button>
    ) : null;

  if (compact) {
    return (
      <div className={cn('flex items-center gap-2.5 rounded-lg border border-l-[3px] border-line bg-surface-1 px-3 py-2.5', LEFT_BORDER[look.bar])}>
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="text-[13px] font-semibold">{incidentTitle(incident)}</span>
          <span className="truncate text-[12px] text-ink-muted">
            <Link to={serverPath(incident.server_id)} className="text-ink-muted no-underline hover:text-ink">
              {incident.server_name}
            </Link>{' '}
            · <span className="num">{duration}</span>
          </span>
        </div>
        {acked ? <Chip>Acked</Chip> : ack}
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-2 rounded-lg border border-l-[3px] border-line bg-surface-1 px-3.5 py-3', LEFT_BORDER[look.bar])}>
      <div className="flex items-center gap-2">
        <StatusBadge status={look.status} size="sm" text={look.label} />
        <span className="num ml-auto text-[12px] text-ink-faint">{duration}</span>
      </div>
      <div className="text-[13px] font-semibold">{incidentTitle(incident)}</div>
      <Link to={serverPath(incident.server_id)} className="truncate text-[13px] text-ink-muted no-underline hover:text-ink">
        {incident.server_name}
      </Link>
      <div className="flex items-center gap-2">
        <span className="num flex-1 text-[12px] text-ink-muted">
          peak <span className="text-ink">{incidentPeak(incident, now)}</span>
          {threshold && <> / {threshold}</>}
        </span>
        {acked ? <Chip>Acked</Chip> : ack}
      </div>
    </div>
  );
}

