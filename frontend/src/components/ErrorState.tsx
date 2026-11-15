import { ArrowPathIcon } from '@heroicons/react/24/outline';
import { useEffect, useState, type ReactNode } from 'react';

import { errorMessage, isApiError } from '../api/errors';
import { useNow } from '../hooks/useNow';
import { cn } from '../lib/cn';
import { formatClock } from '../lib/format';

import { Button } from './Button';
import { StatusIcon } from './StatusBadge';

/** Heroicons-style "wifi off" from States.dc.html (not in Heroicons). */
export function WifiOffIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true" className={className}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 3l18 18M8.288 15.038a5.25 5.25 0 0 1 7.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 0 1 1.06 0Z"
      />
    </svg>
  );
}

const MS_PER_SECOND = 1000;

function titleFor(error: unknown): string {
  if (!isApiError(error)) return 'Something went wrong';
  switch (error.code) {
    case 'network':
    case 'timeout':
      return 'Can’t reach the Monitaur API';
    case 'forbidden':
      return 'You don’t have access to this';
    case 'not_found':
      return 'Not found';
    case 'rate_limited':
      return 'Slow down a little';
    default:
      return 'The Monitaur API returned an error';
  }
}

export interface ErrorStateProps {
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  /** page: the large card (keeps stale data visible around it); widget: one line inside a widget. */
  variant?: 'page' | 'widget';
  title?: ReactNode;
  /** Page variant: overrides the explanatory sentence. */
  description?: ReactNode;
  /** When the data on screen was last good (ms epoch), for "Showing the last data we received". */
  staleSince?: number | null;
  /** Page variant: retry automatically after this many ms, with a countdown. */
  autoRetryMs?: number;
  className?: string;
}

/**
 * States.dc.html "Error with retry". Page-level errors keep stale data
 * visible; widget-level errors stay inside the widget.
 */
export function ErrorState({
  error,
  onRetry,
  retrying = false,
  variant = 'page',
  title,
  description,
  staleSince = null,
  autoRetryMs,
  className,
}: ErrorStateProps) {
  if (variant === 'widget') {
    return (
      <div role="alert" className={cn('flex items-center gap-2.5 rounded-lg border border-line bg-surface-1 px-3.5 py-3', className)}>
        <StatusIcon status="warning" className="text-warn" />
        <span className="flex-1 text-[13px]">{title ?? errorMessage(error)}</span>
        {onRetry && (
          <Button size="sm" variant="ghost" onClick={onRetry} loading={retrying}>
            Retry
          </Button>
        )}
      </div>
    );
  }

  return (
    <div role="alert" className={cn('flex items-start gap-3.5 rounded-lg border border-crit bg-surface-1 p-5', className)}>
      <span className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-tint-crit text-crit">
        <WifiOffIcon className="h-5 w-5" />
      </span>
      <div className="flex flex-1 flex-col gap-1.5">
        <h2 className="m-0 text-[15px] font-semibold">{title ?? titleFor(error)}</h2>
        <p className="m-0 text-[13px] text-ink-muted">
          {description ??
            (staleSince !== null ? (
              <>
                Showing the last data we received, from <span className="num">{formatClock(staleSince)}</span>.
              </>
            ) : isApiError(error) && (error.code === 'network' || error.code === 'timeout') ? (
              'Check your connection, or whether the Monitaur API is running. We’ll keep trying.'
            ) : (
              errorMessage(error)
            ))}
        </p>
        {isApiError(error) && <code className="num text-[12px] text-ink-faint">{error.summary}</code>}
        {onRetry && <RetryControls onRetry={onRetry} retrying={retrying} autoRetryMs={autoRetryMs} />}
      </div>
    </div>
  );
}

function RetryControls({ onRetry, retrying, autoRetryMs }: { onRetry: () => void; retrying: boolean; autoRetryMs: number | undefined }) {
  const now = useNow();
  const [deadline, setDeadline] = useState<number | null>(() => (autoRetryMs ? Date.now() + autoRetryMs : null));
  const remaining = deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / MS_PER_SECOND));

  useEffect(() => {
    if (deadline === null || retrying || remaining === null || remaining > 0) return;
    setDeadline(autoRetryMs ? Date.now() + autoRetryMs : null);
    onRetry();
  }, [autoRetryMs, deadline, onRetry, remaining, retrying]);

  return (
    <div className="mt-1 flex items-center gap-2">
      <Button size="sm" onClick={onRetry} loading={retrying} leadingIcon={<ArrowPathIcon className="h-3.5 w-3.5" strokeWidth={1.8} />}>
        Retry now
      </Button>
      {remaining !== null && !retrying && <span className="num text-[12px] text-ink-faint">auto-retry in {remaining} s</span>}
    </div>
  );
}
