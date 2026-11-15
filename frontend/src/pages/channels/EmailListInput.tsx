import { useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';

import { Field } from '../../components/Input';
import { cn } from '../../lib/cn';

import { isEmail, MAX_EMAIL_RECIPIENTS, parseRecipients } from './channelModel';

const COMMIT_KEYS = new Set(['Enter', ',', ';', ' ']);

export interface EmailListInputProps {
  label: ReactNode;
  value: readonly string[];
  onChange: (recipients: string[]) => void;
  /** Text typed but not yet turned into a chip; the dialog commits it on submit. */
  draft: string;
  onDraftChange: (draft: string) => void;
  hint?: ReactNode;
  error?: ReactNode;
  disabled?: boolean;
}

/**
 * Recipients as chips in an input well, like TagInput but for addresses:
 * Enter, comma, space or paste adds; Backspace on empty removes the last.
 * Invalid addresses stay as red chips so they can be fixed or removed.
 */
export function EmailListInput({ label, value, onChange, draft, onDraftChange, hint, error, disabled = false }: EmailListInputProps) {
  const [focused, setFocused] = useState(false);

  const commit = (raw: string): void => {
    const added = parseRecipients(raw, value);
    onDraftChange('');
    if (added.length > 0) onChange([...value, ...added].slice(0, MAX_EMAIL_RECIPIENTS + 1));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (COMMIT_KEYS.has(event.key) && draft.trim() !== '') {
      event.preventDefault();
      commit(draft);
    } else if (event.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>): void => {
    const text = event.clipboardData.getData('text');
    if (!/[\s,;]/.test(text)) return;
    event.preventDefault();
    commit(`${draft} ${text}`);
  };

  return (
    <Field label={label} hint={hint} error={error}>
      {({ id, describedBy, invalid }) => (
        <div
          className={cn(
            'flex min-h-10 flex-wrap items-center gap-1.5 rounded border bg-bg p-1.5',
            focused && 'border-accent shadow-[0_0_0_3px_rgb(var(--ac-soft))]',
            !focused && (invalid ? 'border-crit' : 'border-line-strong'),
            disabled && 'opacity-60',
          )}
        >
          {value.map((address) => {
            const valid = isEmail(address);
            return (
              <span
                key={address}
                className={cn(
                  'num inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-sm border bg-surface-2 px-[7px] text-[12px] font-medium',
                  valid ? 'border-line text-ink-muted' : 'border-crit text-crit',
                )}
              >
                {address}
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove ${address}`}
                  title={`Remove ${address}`}
                  onClick={() => {
                    onChange(value.filter((item) => item !== address));
                  }}
                  className="cursor-pointer border-0 bg-transparent p-0 text-[14px] leading-none text-ink-faint hover:text-ink"
                >
                  ×
                </button>
              </span>
            );
          })}
          <input
            id={id}
            type="email"
            multiple
            value={draft}
            disabled={disabled}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            placeholder={value.length === 0 ? 'ops@yourteam.dev' : 'Add another…'}
            autoComplete="off"
            spellCheck={false}
            onFocus={() => {
              setFocused(true);
            }}
            onBlur={() => {
              setFocused(false);
              if (draft.trim() !== '') commit(draft);
            }}
            onChange={(event) => {
              onDraftChange(event.target.value);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            className="num min-w-[160px] flex-1 border-0 bg-transparent px-1.5 text-[13px] text-ink outline-none placeholder:text-ink-faint focus-visible:outline-none"
          />
        </div>
      )}
    </Field>
  );
}
