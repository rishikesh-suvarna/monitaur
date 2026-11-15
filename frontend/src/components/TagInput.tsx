import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';

import { cn } from '../lib/cn';
import { normalizeTag } from '../lib/names';

import { ChipButton } from './Chip';
import { Field } from './Input';

const TAG_SEPARATORS = new Set(['Enter', ',']);

export interface TagInputProps {
  value: readonly string[];
  onChange: (tags: string[]) => void;
  label: ReactNode;
  hint?: ReactNode;
  /** Existing tags offered as one-click toggle chips. */
  suggestions?: readonly string[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * ServerSettings.dc.html tags field: chips with a remove button inside an
 * input well. Enter or comma adds; Backspace on an empty input removes the
 * last tag. Suggestions render as toggle chips (Onboarding.dc.html).
 */
export function TagInput({ value, onChange, label, hint, suggestions = [], placeholder = 'Add tag…', disabled = false, className }: TagInputProps) {
  const [draft, setDraft] = useState('');
  const suggestionsId = useId();

  const add = (raw: string): void => {
    const tag = normalizeTag(raw);
    setDraft('');
    if (tag === '' || value.includes(tag)) return;
    onChange([...value, tag]);
  };
  const remove = (tag: string): void => {
    onChange(value.filter((item) => item !== tag));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (TAG_SEPARATORS.has(event.key)) {
      event.preventDefault();
      add(draft);
    } else if (event.key === 'Backspace' && draft === '' && value.length > 0) {
      const last = value[value.length - 1];
      if (last !== undefined) remove(last);
    }
  };

  const offered = [...new Set(suggestions)].filter((tag) => tag !== '');

  return (
    <Field label={label} hint={hint} className={className}>
      {({ id, describedBy }) => (
        <div className="flex flex-col gap-2">
          <div
            className={cn(
              'flex min-h-9 flex-wrap items-center gap-1.5 rounded border border-line-strong bg-bg p-1.5',
              'focus-within:border-accent focus-within:shadow-[0_0_0_3px_rgb(var(--ac-soft))]',
              disabled && 'opacity-60',
            )}
          >
            {value.map((tag) => (
              <span
                key={tag}
                className="inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-sm border border-line bg-surface-2 px-[7px] text-[12px] font-medium text-ink-muted"
              >
                {tag}
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove tag ${tag}`}
                  onClick={() => {
                    remove(tag);
                  }}
                  className="cursor-pointer border-0 bg-transparent p-0 text-[14px] leading-none text-ink-faint hover:text-ink"
                >
                  ×
                </button>
              </span>
            ))}
            <input
              id={id}
              value={draft}
              disabled={disabled}
              placeholder={placeholder}
              aria-describedby={describedBy}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
              onKeyDown={onKeyDown}
              onBlur={() => {
                if (draft.trim() !== '') add(draft);
              }}
              className="min-w-[100px] flex-1 border-0 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint focus-visible:outline-none"
            />
          </div>
          {offered.length > 0 && (
            <div role="group" aria-labelledby={suggestionsId} className="flex flex-wrap items-center gap-1.5">
              <span id={suggestionsId} className="sr-only">
                Existing tags
              </span>
              {offered.map((tag) => {
                const on = value.includes(tag);
                return (
                  <ChipButton
                    key={tag}
                    pressed={on}
                    disabled={disabled}
                    onClick={() => {
                      if (on) remove(tag);
                      else onChange([...value, tag]);
                    }}
                  >
                    {tag}
                  </ChipButton>
                );
              })}
            </div>
          )}
        </div>
      )}
    </Field>
  );
}
