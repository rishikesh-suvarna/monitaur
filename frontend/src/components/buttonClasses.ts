import { cn } from '../lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-outline';
export type ButtonSize = 'sm' | 'md' | 'lg';

const BASE =
  'inline-flex items-center justify-center whitespace-nowrap rounded border font-medium leading-none no-underline ' +
  'transition-[background-color,border-color,filter] duration-150 ease-out ' +
  'disabled:cursor-not-allowed disabled:opacity-[0.45] disabled:filter-none ' +
  'aria-disabled:cursor-not-allowed aria-disabled:opacity-[0.45]';

// Components.dc.html: .btn, .btn-p, .btn-g, .btn-d, .btn-do
const VARIANTS: Record<ButtonVariant, string> = {
  secondary: 'border-line-strong bg-surface-2 text-ink hover:bg-surface-3 hover:text-ink',
  primary: 'border-accent bg-accent font-semibold text-accent-ink hover:bg-accent hover:text-accent-ink hover:brightness-[1.08]',
  ghost: 'border-transparent bg-transparent text-ink-muted hover:bg-surface-2 hover:text-ink',
  danger: 'border-crit bg-crit font-semibold text-bg hover:bg-crit hover:text-bg hover:brightness-[1.06]',
  'danger-outline': 'border-crit bg-transparent text-crit hover:bg-tint-crit hover:text-crit',
};

// h 36 · r 6 · sm 28 · lg 44
const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 gap-1.5 px-2.5 text-[12px]',
  md: 'h-9 gap-2 px-3.5 text-[13px]',
  lg: 'h-11 gap-2 px-[18px] text-[14px]',
};

export interface ButtonStyleProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Stretch to the container width. */
  block?: boolean;
}

export function buttonClasses({ variant = 'secondary', size = 'md', block = false }: ButtonStyleProps = {}): string {
  return cn(BASE, VARIANTS[variant], SIZES[size], block && 'w-full');
}
