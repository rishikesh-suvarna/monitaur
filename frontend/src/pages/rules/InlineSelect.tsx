import { useId, type SelectHTMLAttributes } from 'react';

import { inputClasses } from '../../components/inputClasses';
import { cn } from '../../lib/cn';

export interface InlineOption<T extends string | number> {
  value: T;
  label: string;
}

export interface InlineSelectProps<T extends string | number>
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange' | 'size'> {
  /** Accessible name; the sentence around the select is the visible label. */
  label: string;
  value: T;
  options: readonly InlineOption<T>[];
  onChange: (value: T) => void;
  /** lg: the 40 px condition sentence; sm: the 28 px mono timer selects. */
  size?: 'lg' | 'sm';
  invalid?: boolean;
}

/**
 * Rules.dc.html sentence controls are native selects (.inp with the caret):
 * they sit inline in running text and get the platform picker on phones.
 */
export function InlineSelect<T extends string | number>({
  label,
  value,
  options,
  onChange,
  size = 'lg',
  invalid = false,
  className,
  id,
  ...rest
}: InlineSelectProps<T>) {
  const autoId = useId();
  const selectId = id ?? `sel${autoId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <>
      <label htmlFor={selectId} className="sr-only">
        {label}
      </label>
      <select
        id={selectId}
        value={String(value)}
        aria-invalid={invalid || undefined}
        onChange={(event) => {
          const picked = options.find((option) => String(option.value) === event.target.value);
          if (picked) onChange(picked.value);
        }}
        className={cn(
          inputClasses(size === 'lg' ? 'lg' : 'sm', invalid),
          'select-caret cursor-pointer appearance-none pr-[30px]',
          size === 'lg' ? 'font-semibold' : 'num h-7 pl-2 text-[12px]',
          className,
        )}
        {...rest}
      >
        {options.map((option) => (
          <option key={String(option.value)} value={String(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
    </>
  );
}
