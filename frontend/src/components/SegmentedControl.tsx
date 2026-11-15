import type { ReactNode } from 'react';

import { cn } from '../lib/cn';

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  /** Trailing extra, e.g. a count. */
  suffix?: ReactNode;
  /** Accessible name when the label is not plain text. */
  'aria-label'?: string;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentOption<T>[];
  'aria-label': string;
  /** md: 28 px segments; touch: 36 px for mobile. */
  size?: 'md' | 'touch';
  className?: string;
}

/**
 * Components.dc.html .seg: a group of aria-pressed buttons on surface-2; the
 * pressed one is raised to surface-3 with an inset line.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  className,
  ...rest
}: SegmentedControlProps<T>) {
  return (
    <div
      role="group"
      aria-label={rest['aria-label']}
      className={cn('inline-flex gap-[2px] rounded border border-line bg-surface-2 p-[2px]', className)}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          aria-label={option['aria-label']}
          onClick={() => {
            onChange(option.value);
          }}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-sm px-2.5 text-[12px] font-medium text-ink-muted',
            'transition-colors duration-150 ease-out hover:text-ink',
            'aria-pressed:bg-surface-3 aria-pressed:text-ink aria-pressed:shadow-[inset_0_0_0_1px_rgb(var(--bd2))]',
            size === 'touch' ? 'h-9' : 'h-7',
          )}
        >
          {option.icon}
          {option.label}
          {option.suffix}
        </button>
      ))}
    </div>
  );
}
