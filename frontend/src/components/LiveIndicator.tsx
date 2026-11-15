import { useNow } from '../hooks/useNow';
import { cn } from '../lib/cn';
import { formatRelativeTime } from '../lib/format';
import { useLiveStatus } from '../providers/LiveStreamProvider';

import { LiveDot } from './LiveDot';

const MS_PER_SECOND = 1000;

export interface LiveIndicatorProps {
  /** Server count for "13 servers"; omitted hides that part. */
  serverCount?: number;
  /** Fallback freshness (e.g. the query's dataUpdatedAt) before the first live event. */
  fallbackUpdatedAt?: number | null;
  className?: string;
}

/**
 * Main.dc.html "Live · 13 servers · updated 2s ago", driven by the live
 * stream. Shows Connecting / Reconnecting / Offline when it is not live.
 */
export function LiveIndicator({ serverCount, fallbackUpdatedAt = null, className }: LiveIndicatorProps) {
  const live = useLiveStatus();
  const now = useNow();
  const updatedAt = live.lastServersAt ?? fallbackUpdatedAt;
  const retryIn = live.retryAt === null ? null : Math.max(0, Math.ceil((live.retryAt - now) / MS_PER_SECOND));

  const state =
    live.state === 'open'
      ? { tone: 'ok' as const, pulse: true, label: 'Live' }
      : live.state === 'reconnecting'
        ? { tone: 'warn' as const, pulse: false, label: retryIn !== null && retryIn > 0 ? `Reconnecting in ${retryIn}s` : 'Reconnecting' }
        : live.state === 'connecting'
          ? { tone: 'off' as const, pulse: false, label: 'Connecting' }
          : { tone: 'off' as const, pulse: false, label: 'Offline' };

  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[12px] text-ink-faint', className)} role="status" aria-live="off">
      <LiveDot size={6} tone={state.tone} pulse={state.pulse} />
      <span>
        {state.label}
        {serverCount !== undefined && (
          <>
            {' · '}
            <span className="num">{serverCount}</span> {serverCount === 1 ? 'server' : 'servers'}
          </>
        )}
        {updatedAt !== null && (
          <>
            {' · updated '}
            <span className="num">{formatRelativeTime(updatedAt, now)}</span>
          </>
        )}
      </span>
    </span>
  );
}
