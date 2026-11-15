import { cn } from '../lib/cn';

export type LiveDotTone = 'ok' | 'warn' | 'off' | 'accent';

const TONE_BG: Record<LiveDotTone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  off: 'bg-off',
  accent: 'bg-accent',
};

export interface LiveDotProps {
  size?: number;
  tone?: LiveDotTone;
  /** Pulse ring; off for stale or offline states. */
  pulse?: boolean;
  className?: string;
}

/** The pulsing dot used for "Live" (Main.dc.html header, TimeRangePicker). */
export function LiveDot({ size = 6, tone = 'ok', pulse = true, className }: LiveDotProps) {
  return (
    <span aria-hidden="true" className={cn('relative inline-block flex-none', className)} style={{ width: size, height: size }}>
      {pulse && <span className={cn('pulse absolute inset-0 rounded-full', TONE_BG[tone])} />}
      <span className={cn('absolute inset-0 rounded-full', TONE_BG[tone])} />
    </span>
  );
}
