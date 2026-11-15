import type { ReactNode } from 'react';

import { cn } from '../lib/cn';
import { usageState, type UsageTone } from '../lib/usage';

import { hintClasses } from './inputClasses';

const FILL_TONE: Record<UsageTone, string> = {
  normal: 'bg-accent',
  near: 'bg-warn',
  full: 'bg-crit',
};

const LABEL_TONE: Record<UsageTone, string> = {
  normal: 'text-ink-muted',
  near: 'text-warn',
  full: 'font-semibold text-crit',
};

export interface UsageMeterProps {
  /** What is being counted, e.g. "Servers". */
  label: ReactNode;
  /** Plain-text plural for the accessible name and value, e.g. "servers". */
  noun: string;
  used: number;
  /** Plan limit; 0 means unlimited. */
  limit: number;
  hint?: ReactNode;
  className?: string;
}

/**
 * Plan usage against a limit: label, "3 of 10" in mono and a 6 px bar. Accent
 * while there is room, warn from 80%, crit at the limit. Unlimited shows a
 * dashed empty track and "no limit".
 */
export function UsageMeter({ label, noun, used, limit, hint, className }: UsageMeterProps) {
  const state = usageState(used, limit);
  const valueText = state.limit === null ? `${state.used} ${noun}, no limit` : `${state.used} of ${state.limit} ${noun} used`;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-baseline gap-2">
        <span className="flex-1 text-[13px] font-medium text-ink">{label}</span>
        <span className={cn('num text-[12px]', LABEL_TONE[state.tone])}>{state.label}</span>
      </div>
      <div
        role="meter"
        aria-label={noun}
        aria-valuemin={0}
        aria-valuemax={state.limit ?? Math.max(1, state.used)}
        aria-valuenow={state.used}
        aria-valuetext={valueText}
        className={cn(
          'h-1.5 overflow-hidden rounded-full',
          state.limit === null ? 'border border-dashed border-line-strong' : 'bg-surface-3',
        )}
      >
        <span className={cn('block h-full rounded-full', FILL_TONE[state.tone])} style={{ width: `${state.percent}%` }} />
      </div>
      {hint && <span className={hintClasses}>{hint}</span>}
    </div>
  );
}
