import { Description, Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { TrashIcon } from '@heroicons/react/24/outline';
import { useId, useState, type ReactNode } from 'react';

import { useIsDesktop } from '../hooks/useMediaQuery';
import { cn } from '../lib/cn';

import { Button } from './Button';
import { hintClasses, inputClasses, labelClasses } from './inputClasses';

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** danger: red confirm button and the trash tile. */
  tone?: 'danger' | 'default';
  icon?: ReactNode;
  /** Type-to-confirm: the confirm button unlocks only when this exact text is typed. */
  confirmText?: string;
  pending?: boolean;
  /** Error from the last attempt, shown above the buttons. */
  error?: ReactNode;
}

/**
 * Components.dc.html / ServerSettings.dc.html ConfirmDialog: Headless UI
 * Dialog (focus trapped, Esc closes) with an optional type-to-confirm field.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  icon,
  confirmText,
  pending = false,
  error,
}: ConfirmDialogProps) {
  const desktop = useIsDesktop();
  const [typed, setTyped] = useState('');
  const [wasOpen, setWasOpen] = useState(open);
  const inputId = useId();
  // Start empty every time the dialog opens, however it was closed last time.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setTyped('');
  }
  const matches = confirmText === undefined || typed === confirmText;

  const close = (): void => {
    if (pending) return;
    setTyped('');
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-scrim" />
      <div className={cn('fixed inset-0 flex justify-center p-4', desktop ? 'items-center' : 'items-end')}>
        <DialogPanel className="flex w-full max-w-[460px] flex-col gap-4 rounded-xl border border-line-strong bg-surface-1 p-6 shadow-float">
          <div className="flex items-start gap-3">
            <span
              className={cn(
                'inline-flex h-9 w-9 flex-none items-center justify-center rounded-lg',
                tone === 'danger' ? 'bg-tint-crit text-crit' : 'bg-tint-accent text-accent',
              )}
            >
              {icon ?? <TrashIcon className="h-5 w-5" strokeWidth={1.6} />}
            </span>
            <div className="flex flex-col gap-1">
              <DialogTitle className="m-0 text-[16px] font-semibold leading-6">{title}</DialogTitle>
              {description && <Description className="m-0 text-[13px] text-ink-muted">{description}</Description>}
            </div>
          </div>

          {confirmText !== undefined && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={inputId} className={labelClasses}>
                Type <span className="num rounded-sm bg-surface-3 px-[5px] py-px text-ink">{confirmText}</span> to confirm
              </label>
              <input
                id={inputId}
                value={typed}
                onChange={(event) => {
                  setTyped(event.target.value);
                }}
                autoComplete="off"
                spellCheck={false}
                data-autofocus
                placeholder={confirmText}
                aria-describedby={`${inputId}-match`}
                className={cn(inputClasses('lg'), 'num', matches && typed !== '' && 'border-ok')}
              />
              <span id={`${inputId}-match`} aria-live="polite" className={hintClasses}>
                {matches ? 'Name matches.' : 'Name must match exactly.'}
              </span>
            </div>
          )}

          {error && (
            <div role="alert" className="rounded bg-tint-crit px-3 py-2.5 text-[13px] text-crit">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close} disabled={pending}>
              {cancelLabel}
            </Button>
            <Button
              variant={tone === 'danger' ? 'danger' : 'primary'}
              disabled={!matches}
              loading={pending}
              onClick={() => {
                void onConfirm();
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
