import { createContext, use, useEffect, useMemo, type ReactNode } from 'react';

import { useMediaQuery } from '../hooks/useMediaQuery';
import { useStoredState } from '../hooks/useStoredState';
import { STORAGE_KEYS, isNullableBoolean } from '../lib/storage';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export interface MotionContextValue {
  /** Effective setting: true means no number ticks, no sparkline sliding. */
  reduced: boolean;
  /** What the OS asks for. */
  systemReduced: boolean;
  /** The user's override from Settings; null follows the OS. */
  override: boolean | null;
  setOverride: (override: boolean | null) => void;
}

const MotionContext = createContext<MotionContextValue | null>(null);

/**
 * Reduce motion follows the OS by default (Settings.dc.html). The override is
 * mirrored to `data-motion` on <html> so the CSS rules in tokens.css apply.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  const [override, setOverride] = useStoredState<boolean | null>(STORAGE_KEYS.reduceMotion, null, isNullableBoolean);
  const systemReduced = useMediaQuery(REDUCED_MOTION_QUERY);
  const reduced = override ?? systemReduced;

  useEffect(() => {
    const root = document.documentElement;
    if (override === null) delete root.dataset.motion;
    else root.dataset.motion = override ? 'reduce' : 'full';
  }, [override]);

  const value = useMemo(
    () => ({ reduced, systemReduced, override, setOverride }),
    [reduced, systemReduced, override, setOverride],
  );
  return <MotionContext value={value}>{children}</MotionContext>;
}

export function useMotion(): MotionContextValue {
  const context = use(MotionContext);
  if (!context) throw new Error('useMotion must be used inside <MotionProvider>');
  return context;
}

/** Shorthand for components that animate in JS. */
export function useReducedMotion(): boolean {
  return useMotion().reduced;
}
