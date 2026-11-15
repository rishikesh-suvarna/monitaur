import { Field as HeadlessField, Label, Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import { CheckIcon } from '@heroicons/react/24/outline';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn';

import { inputClasses, labelClasses, type ControlSize } from './inputClasses';

export interface SelectOption<T extends string | number> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface SelectProps<T extends string | number> {
  value: T;
  onChange: (value: T) => void;
  options: readonly SelectOption<T>[];
  label: ReactNode;
  /** Keep the label for screen readers only (toolbar selects). */
  hideLabel?: boolean;
  /** Label beside the control instead of above it (Main.dc.html "Sort"). */
  inlineLabel?: boolean;
  size?: ControlSize;
  disabled?: boolean;
  className?: string;
}

/**
 * Components.dc.html select (.inp with the 5 px caret), built on Headless UI
 * Listbox as the sheet notes.
 */
export function Select<T extends string | number>({
  value,
  onChange,
  options,
  label,
  hideLabel = false,
  inlineLabel = false,
  size = 'md',
  disabled = false,
  className,
}: SelectProps<T>) {
  const selected = options.find((option) => option.value === value);
  return (
    <HeadlessField
      disabled={disabled}
      className={cn(inlineLabel ? 'flex items-center gap-2' : 'flex flex-col gap-1.5', className)}
    >
      <Label className={cn(inlineLabel ? 'text-[12px] text-ink-faint' : labelClasses, hideLabel && 'sr-only')}>{label}</Label>
      <Listbox value={value} onChange={onChange} disabled={disabled}>
        <ListboxButton className={cn(inputClasses(size), 'select-caret relative pr-[30px] text-left')}>
          <span className="block truncate">{selected?.label}</span>
        </ListboxButton>
        <ListboxOptions
          anchor={{ to: 'bottom start', gap: 4 }}
          className="z-50 min-w-[var(--button-width)] rounded-lg border border-line-strong bg-surface-1 p-1 shadow-float focus:outline-none"
        >
          {options.map((option) => (
            <ListboxOption
              key={String(option.value)}
              value={option.value}
              disabled={option.disabled ?? false}
              className="group flex h-8 cursor-pointer items-center gap-2 rounded-sm px-2 text-[13px] text-ink-muted data-[disabled]:cursor-not-allowed data-[focus]:bg-surface-3 data-[selected]:text-ink data-[disabled]:opacity-50"
            >
              <CheckIcon className="h-3.5 w-3.5 flex-none text-accent opacity-0 group-data-[selected]:opacity-100" strokeWidth={2} />
              <span className="truncate">{option.label}</span>
            </ListboxOption>
          ))}
        </ListboxOptions>
      </Listbox>
    </HeadlessField>
  );
}
