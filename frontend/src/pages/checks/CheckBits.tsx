import { WrenchScrewdriverIcon } from '@heroicons/react/24/outline';

import type { CheckRunResult, CheckStatus, CheckType } from '../../api/types';
import { Chip } from '../../components/Chip';
import { RelativeTime } from '../../components/RelativeTime';
import { StatusBadge, type StatusBadgeProps } from '../../components/StatusBadge';
import { cn } from '../../lib/cn';
import { CHECK_STATUS_META, CHECK_TYPE_LABELS, describeResult } from '../../lib/checks';

/** StatusBadge with the check's word: up/healthy, down/critical, degraded/warning, paused and pending/offline. */
export function CheckStatusBadge({ status, ...rest }: { status: CheckStatus } & Omit<StatusBadgeProps, 'status' | 'text'>) {
  const meta = CHECK_STATUS_META[status];
  return <StatusBadge status={meta.status} text={meta.label} {...rest} />;
}

export function CheckTypeChip({ type, className }: { type: CheckType; className?: string }) {
  return <Chip className={cn('num', className)}>{CHECK_TYPE_LABELS[type]}</Chip>;
}

/** The check is inside an active maintenance window: incidents are recorded but nobody is notified. */
export function MaintenanceChip({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <Chip className={cn('border-accent/40 bg-tint-accent text-ink', className)}>
      <WrenchScrewdriverIcon className="h-3 w-3 flex-none text-accent" strokeWidth={1.8} aria-hidden="true" />
      {compact ? <span className="sr-only">In maintenance</span> : 'Maintenance'}
    </Chip>
  );
}

/** "Run now" answer shown inline: the badge word, the HTTP status or error, the latency and when. */
export function RunResultNote({ result, className }: { result: CheckRunResult; className?: string }) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded border px-3 py-2 text-[12px]',
        result.ok ? 'border-line bg-surface-2' : 'border-crit bg-tint-crit',
        className,
      )}
    >
      <StatusBadge status={result.ok ? 'healthy' : 'critical'} size="sm" variant="inline" text={result.ok ? 'Up' : 'Down'} />
      <span className="num min-w-0 text-ink-muted [overflow-wrap:anywhere]">{describeResult(result)}</span>
      <span className="text-ink-faint">
        ran <RelativeTime value={result.at} />
      </span>
    </div>
  );
}
