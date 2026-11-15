import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { cn } from '../lib/cn';

import { StatusIcon } from './StatusBadge';
import { UsageMeter } from './UsageMeter';

/** Where Settings renders the plan and usage card. */
export const PLAN_SETTINGS_PATH = '/settings#plan';

export interface LimitReachedHintProps {
  /** Plural resource name, e.g. "alert rules". */
  resource: string;
  /** Current usage and plan limit, when known (GET /org usage and plan). */
  used?: number;
  limit?: number;
  planName?: string;
  /** What the user can do instead, e.g. "Delete a rule you no longer need." */
  action?: ReactNode;
  /** Link to the plan and usage card in Settings. */
  settingsLink?: boolean;
  className?: string;
}

/**
 * The `limit_reached` answer (PLAN.md 3.6): a warn-tinted note with the plan
 * usage and a way forward, instead of a generic error.
 */
export function LimitReachedHint({ resource, used, limit, planName, action, settingsLink = true, className }: LimitReachedHintProps) {
  return (
    <div role="alert" className={cn('flex items-start gap-3 rounded-lg border border-warn bg-tint-warn px-3.5 py-3', className)}>
      <StatusIcon status="warning" size={16} className="mt-0.5 text-warn" />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex flex-col gap-0.5">
          <span className="text-[13px] font-semibold text-ink">Plan limit reached</span>
          <span className="text-[13px] text-ink-muted">
            {planName ? `The ${planName} plan` : 'Your plan'} has no room for more {resource}.{action && <> {action}</>}
          </span>
        </div>
        {used !== undefined && limit !== undefined && (
          <UsageMeter label={<span className="capitalize">{resource}</span>} noun={resource} used={used} limit={limit} />
        )}
        {settingsLink && (
          <Link to={PLAN_SETTINGS_PATH} className="self-start text-[13px]">
            See plan and usage
          </Link>
        )}
      </div>
    </div>
  );
}
