import { createContext, use, useEffect, useMemo, type ReactNode } from 'react';

import { useMediaQuery } from '../hooks/useMediaQuery';
import { useStoredState } from '../hooks/useStoredState';
import { STORAGE_KEYS, oneOf } from '../lib/storage';

export const THEME_PREFERENCES = ['dark', 'light', 'system'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = 'dark' | 'light';

/** Dark is the default theme (Tokens.dc.html). */
export const DEFAULT_THEME: ThemePreference = 'dark';
const LIGHT_SCHEME_QUERY = '(prefers-color-scheme: light)';

export interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useStoredState<ThemePreference>(
    STORAGE_KEYS.theme,
    DEFAULT_THEME,
    oneOf(THEME_PREFERENCES),
  );
  const systemLight = useMediaQuery(LIGHT_SCHEME_QUERY);
  const resolved: ResolvedTheme = preference === 'system' ? (systemLight ? 'light' : 'dark') : preference;

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  const value = useMemo(() => ({ preference, resolved, setPreference }), [preference, resolved, setPreference]);
  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme(): ThemeContextValue {
  const context = use(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside <ThemeProvider>');
  return context;
}
