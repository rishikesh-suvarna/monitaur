import type { ServerStatus } from '../api/types';

const TONE_TEXT: Record<ServerStatus, string> = {
  healthy: 'text-ok',
  warning: 'text-warn',
  critical: 'text-crit',
  offline: 'text-off',
};

const TONE_TINT: Record<ServerStatus, string> = {
  healthy: 'bg-tint-ok',
  warning: 'bg-tint-warn',
  critical: 'bg-tint-crit',
  offline: 'bg-tint-off',
};

/** Text colour class for a status (numbers and icons outside a badge). */
export const statusTextClass = (status: ServerStatus): string => TONE_TEXT[status];

/** Tinted background class for a status (the design's ok-bg, warn-bg, ...). */
export const statusTintClass = (status: ServerStatus): string => TONE_TINT[status];
