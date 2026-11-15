import type { ServerStatus } from '../api/types';
import { cn } from '../lib/cn';
import { STATUS_META } from '../lib/status';

import { statusTextClass, statusTintClass } from './statusClasses';

interface StatusIconProps {
  status: ServerStatus;
  size?: number;
  strokeWidth?: number;
  className?: string;
}

/**
 * The status shapes: circle + check (healthy), triangle + ! (warning),
 * octagon + x (critical), dashed ring + dash (offline). Decorative; pair it
 * with a word or a visually hidden label.
 */
export function StatusIcon({ status, size = 14, strokeWidth = 1.6, className }: StatusIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn('flex-none', className)}
    >
      {status === 'healthy' && (
        <>
          <circle cx="8" cy="8" r="6.4" />
          <path d="M5.2 8.3l1.9 1.9 3.8-4.1" />
        </>
      )}
      {status === 'warning' && (
        <>
          <path d="M8 1.9l6.5 11.6h-13z" />
          <path d="M8 6.3v3.2M8 11.4v.2" />
        </>
      )}
      {status === 'critical' && (
        <>
          <path d="M5.4 1.6h5.2l3.8 3.8v5.2l-3.8 3.8H5.4l-3.8-3.8V5.4z" />
          <path d="M6.1 6.1l3.8 3.8M9.9 6.1l-3.8 3.8" />
        </>
      )}
      {status === 'offline' && (
        <>
          <circle cx="8" cy="8" r="6.4" strokeDasharray="2.6 2.2" />
          <path d="M5.4 8h5.2" />
        </>
      )}
    </svg>
  );
}

export type StatusBadgeVariant = 'pill' | 'inline' | 'icon';
export type StatusBadgeSize = 'sm' | 'md';

export interface StatusBadgeProps {
  status: ServerStatus;
  /** pill (tinted), inline (no background) or icon (dense rows only). */
  variant?: StatusBadgeVariant;
  size?: StatusBadgeSize;
  /** Overrides the word, e.g. "Acked", "Unreachable", "≥ 90%". */
  text?: string;
  className?: string;
}

/** StatusBadge.dc.html: colour + shape + word. */
export function StatusBadge({ status, variant = 'pill', size = 'md', text, className }: StatusBadgeProps) {
  const label = text ?? STATUS_META[status].label;
  const small = size === 'sm';
  const pill = variant === 'pill';
  const iconOnly = variant === 'icon';

  return (
    <span
      title={iconOnly ? label : undefined}
      className={cn(
        'relative inline-flex items-center whitespace-nowrap rounded-full font-semibold leading-none tracking-[0.01em]',
        statusTextClass(status),
        small ? 'gap-1 text-[12px]' : 'gap-1.5 text-[13px]',
        pill && statusTintClass(status),
        pill && (small ? 'h-5 pl-1.5 pr-2' : 'h-6 pl-[7px] pr-2.5'),
        className,
      )}
    >
      <StatusIcon status={status} size={small ? 12 : 14} />
      {iconOnly ? <span className="sr-only">{label}</span> : <span>{label}</span>}
    </span>
  );
}
