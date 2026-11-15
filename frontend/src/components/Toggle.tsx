import { Description, Field, Label, Switch } from '@headlessui/react';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn';

import { hintClasses } from './inputClasses';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Visible label; with hideLabel it becomes the accessible name only. */
  label: ReactNode;
  hideLabel?: boolean;
  description?: ReactNode;
  disabled?: boolean;
  /** Label left and switch right (settings rows), or switch first (default). */
  labelPosition?: 'after' | 'before';
  className?: string;
}

/** Components.dc.html .sw: 36x20 switch, accent when on. Headless UI Switch. */
export function Toggle({
  checked,
  onChange,
  label,
  hideLabel = false,
  description,
  disabled = false,
  labelPosition = 'after',
  className,
}: ToggleProps) {
  const text = (
    <span className={cn('flex min-w-0 flex-col gap-0.5', labelPosition === 'before' && 'flex-1', hideLabel && 'sr-only')}>
      <Label className="text-[13px] font-medium text-ink">{label}</Label>
      {description && <Description className={hintClasses}>{description}</Description>}
    </span>
  );
  return (
    <Field disabled={disabled} className={cn('flex items-center gap-2.5', className)}>
      {labelPosition === 'before' && text}
      <Switch
        checked={checked}
        onChange={onChange}
        className={cn(
          'group relative h-5 w-9 flex-none cursor-pointer rounded-full border border-line-strong bg-surface-3 p-0',
          'transition-colors duration-150 ease-out',
          'data-[checked]:border-accent data-[checked]:bg-accent',
          'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
        )}
      >
        <span
          aria-hidden="true"
          className="absolute left-[2px] top-[2px] h-3.5 w-3.5 rounded-full bg-ink-muted transition-transform duration-150 ease-out group-data-[checked]:translate-x-4 group-data-[checked]:bg-accent-ink"
        />
      </Switch>
      {labelPosition === 'after' && text}
    </Field>
  );
}
