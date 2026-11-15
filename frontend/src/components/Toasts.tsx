import { XMarkIcon } from '@heroicons/react/24/outline';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { ServerStatus } from '../api/types';
import { IconButton } from './IconButton';
import { statusTextClass } from './statusClasses';
import { StatusIcon } from './StatusBadge';
import { cn } from '../lib/cn';

import { ToastContext, type ToastInput, type ToastTone } from './toastContext';

export const TOAST_DURATION_MS = 5000;
const MAX_TOASTS = 4;

const TONE_STATUS: Record<ToastTone, ServerStatus | null> = {
  success: 'healthy',
  error: 'critical',
  warning: 'warning',
  info: null,
};

interface ToastItem extends ToastInput {
  id: number;
}

/** Toasts: floating cards (shadow token), bottom right, above the tab bar on mobile. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback((input: ToastInput) => {
    const id = nextId.current++;
    setToasts((current) => [...current, { ...input, id }].slice(-MAX_TOASTS));
    return id;
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext value={value}>
      {children}
      <div
        aria-live="polite"
        aria-relevant="additions"
        className="pointer-events-none fixed inset-x-4 bottom-[100px] z-[60] flex flex-col items-end gap-2 md:inset-x-auto md:bottom-6 md:right-6"
      >
        {toasts.map((item) => (
          <Toast key={item.id} item={item} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext>
  );
}

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const status = TONE_STATUS[item.tone ?? 'info'];
  const duration = item.duration ?? TOAST_DURATION_MS;

  useEffect(() => {
    if (duration === 0) return undefined;
    const timer = setTimeout(() => {
      onDismiss(item.id);
    }, duration);
    return () => {
      clearTimeout(timer);
    };
  }, [duration, item.id, onDismiss]);

  return (
    <div
      role={item.tone === 'error' ? 'alert' : 'status'}
      className="pointer-events-auto flex w-full max-w-[360px] items-start gap-2.5 rounded-lg border border-line-strong bg-surface-1 py-3 pl-3.5 pr-2 shadow-float"
    >
      {status && <StatusIcon status={status} size={16} className={cn('mt-0.5', statusTextClass(status))} />}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13px] font-semibold">{item.title}</span>
        {item.description && <span className="text-[12px] text-ink-muted">{item.description}</span>}
      </div>
      <IconButton
        size="sm"
        aria-label="Dismiss notification"
        onClick={() => {
          onDismiss(item.id);
        }}
        icon={<XMarkIcon className="h-4 w-4" strokeWidth={1.8} />}
      />
    </div>
  );
}
