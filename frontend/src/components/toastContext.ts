import { createContext, use, type ReactNode } from 'react';

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export interface ToastInput {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  /** ms; 0 keeps it until dismissed. */
  duration?: number;
}

export interface ToastContextValue {
  toast: (input: ToastInput) => number;
  dismiss: (id: number) => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);

/** toast({ title, description, tone }) from anywhere under <ToastProvider>. */
export function useToast(): ToastContextValue {
  const context = use(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}
