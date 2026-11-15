import { cn } from '../lib/cn';

export type ControlSize = 'sm' | 'md' | 'lg' | 'xl';

// 32 (compact toolbars), 36 (controls), 40 (dialogs), 44 (sign-in, touch)
export const CONTROL_HEIGHTS: Record<ControlSize, string> = {
  sm: 'h-8 text-[13px]',
  md: 'h-9 text-[14px]',
  lg: 'h-10 text-[14px]',
  xl: 'h-11 text-[14px]',
};

/** Components.dc.html .inp: bg-coloured well, line-strong border, accent focus ring. */
export function inputClasses(size: ControlSize = 'md', invalid = false): string {
  return cn(
    'min-w-0 rounded border bg-bg px-3 text-ink placeholder:text-ink-faint',
    'focus:border-accent focus:shadow-[0_0_0_3px_rgb(var(--ac-soft))] focus:outline-none',
    'disabled:cursor-not-allowed disabled:opacity-60',
    invalid ? 'border-crit' : 'border-line-strong',
    CONTROL_HEIGHTS[size],
  );
}

export const labelClasses = 'text-[13px] font-medium text-ink';
export const hintClasses = 'text-[12px] leading-4 text-ink-faint';
