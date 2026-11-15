import { useId, type InputHTMLAttributes, type ReactNode, type Ref } from 'react';

import { cn } from '../lib/cn';

import { hintClasses, inputClasses, labelClasses, type ControlSize } from './inputClasses';
import { StatusIcon } from './StatusBadge';

export type { ControlSize } from './inputClasses';

export interface FieldIds {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
}

export interface FieldProps {
  label?: ReactNode;
  /** Visually hide the label but keep it for screen readers. */
  hideLabel?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  /** Right-aligned extra beside the label, e.g. "Forgot password?". */
  labelAside?: ReactNode;
  id?: string;
  className?: string;
  children: (ids: FieldIds) => ReactNode;
}

/** Label + control + hint/error, wired with ids and aria-describedby. */
export function Field({ label, hideLabel = false, hint, error, labelAside, id, className, children }: FieldProps) {
  const autoId = useId();
  const controlId = id ?? `f${autoId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  const invalid = Boolean(error);

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label !== undefined && (
        <div className={cn('flex items-baseline justify-between gap-2', hideLabel && !labelAside && 'sr-only')}>
          <label htmlFor={controlId} className={cn(labelClasses, hideLabel && 'sr-only')}>
            {label}
          </label>
          {labelAside}
        </div>
      )}
      {children({ id: controlId, describedBy, invalid })}
      {error && (
        <span id={errorId} className="inline-flex items-center gap-1 text-[12px] leading-4 text-crit">
          <StatusIcon status="critical" size={12} />
          {error}
        </span>
      )}
      {hint && (
        <span id={hintId} className={hintClasses}>
          {hint}
        </span>
      )}
    </div>
  );
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: ReactNode;
  hideLabel?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  labelAside?: ReactNode;
  size?: ControlSize;
  /** Icon inside the left edge (e.g. a search glass). */
  leading?: ReactNode;
  /** Element inside the right edge (e.g. a Kbd or a Show button). */
  trailing?: ReactNode;
  /** Extra classes for the wrapper around label and control. */
  fieldClassName?: string;
  ref?: Ref<HTMLInputElement>;
}

/** Text input with optional label, hint, error and inline adornments. */
export function Input({
  label,
  hideLabel,
  hint,
  error,
  labelAside,
  size = 'md',
  leading,
  trailing,
  className,
  fieldClassName,
  id,
  ref,
  ...rest
}: InputProps) {
  return (
    <Field label={label} hideLabel={hideLabel} hint={hint} error={error} labelAside={labelAside} id={id} className={fieldClassName}>
      {({ id: controlId, describedBy, invalid }) => (
        <div className="relative flex">
          {leading && (
            <span className="pointer-events-none absolute left-[11px] top-1/2 flex -translate-y-1/2 text-ink-faint">{leading}</span>
          )}
          <input
            ref={ref}
            id={controlId}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            className={cn(inputClasses(size, invalid), 'flex-1', leading !== undefined && 'pl-[34px]', trailing !== undefined && 'pr-11', className)}
            {...rest}
          />
          {trailing && <span className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center">{trailing}</span>}
        </div>
      )}
    </Field>
  );
}
