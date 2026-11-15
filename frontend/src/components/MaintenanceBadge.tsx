import { Popover, PopoverButton, PopoverPanel } from '@headlessui/react';
import { WrenchIcon } from '@heroicons/react/24/outline';

import { cn } from '../lib/cn';

/** What a maintenance window means for this server (docs/platform-v2.md section 6.4). */
export const MAINTENANCE_EXPLANATION = 'Notifications are paused during a maintenance window. Incidents are still recorded.';

// Accent-tinted chip, deliberately not a status: maintenance says nothing about health.
const BADGE =
  'relative inline-flex flex-none items-center whitespace-nowrap rounded-sm border border-accent/40 bg-tint-accent font-medium leading-none text-ink';
const SIZES = { sm: 'h-[22px] gap-1 px-1.5 text-[12px]', md: 'h-6 gap-1.5 px-2 text-[13px]' } as const;
const ICON_SIZES = { sm: 'h-3 w-3', md: 'h-3.5 w-3.5' } as const;

export interface MaintenanceBadgeProps {
  /** sm: dense rows and cards (22 px, like a tag chip); md: beside the 24 px status pill in a header. */
  size?: 'sm' | 'md';
  /**
   * A button that opens the explanation, for headers (keyboard and touch).
   * Without it the badge is static with a native tooltip, for rows whose whole
   * area is already a link.
   */
  interactive?: boolean;
  className?: string;
}

/**
 * "Maintenance" with a wrench: the server is inside an active maintenance
 * window, so alerts are recorded but nobody is notified.
 */
export function MaintenanceBadge({ size = 'sm', interactive = false, className }: MaintenanceBadgeProps) {
  const content = (
    <>
      <WrenchIcon className={cn('flex-none text-accent', ICON_SIZES[size])} strokeWidth={1.8} aria-hidden="true" />
      Maintenance
    </>
  );

  if (!interactive) {
    return (
      // `relative` lifts it over a stretched row link so the tooltip is reachable by pointer.
      <span className={cn(BADGE, SIZES[size], className)} title={MAINTENANCE_EXPLANATION}>
        {content}
        <span className="sr-only">: notifications paused</span>
      </span>
    );
  }

  return (
    <Popover className={cn('relative inline-flex', className)}>
      <PopoverButton
        title={MAINTENANCE_EXPLANATION}
        className={cn(BADGE, SIZES[size], 'cursor-pointer transition-colors duration-150 ease-out hover:border-accent data-[open]:border-accent')}
      >
        {content}
        <span className="sr-only">: notifications paused. Show details</span>
      </PopoverButton>
      <PopoverPanel
        anchor={{ to: 'bottom start', gap: 6 }}
        className="z-50 w-[280px] max-w-[calc(100vw-32px)] rounded-lg border border-line-strong bg-surface-1 p-3 text-[13px] shadow-float focus:outline-none"
      >
        <p className="m-0 flex items-center gap-1.5 font-semibold">
          <WrenchIcon className="h-4 w-4 flex-none text-accent" strokeWidth={1.8} aria-hidden="true" />
          Maintenance window
        </p>
        <p className="m-0 mt-1.5 text-ink-muted">{MAINTENANCE_EXPLANATION}</p>
      </PopoverPanel>
    </Popover>
  );
}
