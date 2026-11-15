import { useId } from 'react';

import { cn } from '../lib/cn';

import { WATCHER_OUTER_PATH, WATCHER_PUPIL_PATH } from './Logo';

export interface LoaderProps {
  /** px. Loader.dc.html uses 96 for app start, 48 on accent, 24 and 18 inline. */
  size?: number;
  /** Accessible name; pass null when a parent already announces the wait. */
  label?: string | null;
  className?: string;
}

/**
 * Loader.dc.html: the Watcher eye glances left, right, then blinks (3.2 s
 * loop). Colour comes from currentColor. Use for app start-up and short waits;
 * lists and charts use skeletons.
 */
export function Loader({ size = 24, label = 'Loading', className }: LoaderProps) {
  const maskId = `mt-eye-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const svg = (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true" className="flex-none">
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="48">
          <rect width="48" height="48" fill="#fff" />
          <path className="mt-pupil" fill="#000" d={WATCHER_PUPIL_PATH} />
        </mask>
      </defs>
      <g className="mt-lid" data-motion-steps="">
        <path fill="currentColor" mask={`url(#${maskId})`} d={WATCHER_OUTER_PATH} />
      </g>
    </svg>
  );

  if (label === null) return <span className={cn('inline-flex', className)}>{svg}</span>;
  return (
    <span role="status" className={cn('inline-flex', className)}>
      {svg}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** Full-viewport start-up state: the 96 px eye centred on the page. */
export function FullScreenLoader({ label = 'Loading Monitaur' }: { label?: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg text-accent">
      <Loader size={96} label={label} />
    </div>
  );
}
