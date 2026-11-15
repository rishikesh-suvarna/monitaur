import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { cn } from '../lib/cn';

const CHIP_BASE =
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border border-line bg-surface-2 text-[12px] font-medium text-ink-muted';

/** A static tag chip (22 px). */
export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn(CHIP_BASE, 'h-[22px] px-[7px]', className)}>{children}</span>;
}

export interface ChipButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  pressed: boolean;
  /** md 28 px (desktop filters), lg 32/36 px on touch screens. */
  size?: 'md' | 'lg' | 'touch';
}

const CHIP_BUTTON_SIZES = { md: 'h-7 px-2.5', lg: 'h-8 px-2.5', touch: 'h-9 px-3' } as const;

/** A toggle chip for filters (aria-pressed), accent-tinted when on. */
export function ChipButton({ pressed, size = 'md', className, type = 'button', ...rest }: ChipButtonProps) {
  return (
    <button
      type={type}
      aria-pressed={pressed}
      className={cn(
        CHIP_BASE,
        CHIP_BUTTON_SIZES[size],
        'cursor-pointer transition-colors duration-150 ease-out hover:text-ink',
        'aria-pressed:border-accent aria-pressed:bg-tint-accent aria-pressed:text-ink',
        className,
      )}
      {...rest}
    />
  );
}
