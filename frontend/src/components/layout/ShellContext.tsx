import { createContext, use } from 'react';

export interface ShellContextValue {
  /** Opens the command palette (Cmd/Ctrl+K). */
  openPalette: () => void;
}

export const ShellContext = createContext<ShellContextValue | null>(null);

/** Shell actions for pages rendered inside <AppShell>. */
export function useShell(): ShellContextValue {
  const context = use(ShellContext);
  if (!context) throw new Error('useShell must be used inside <AppShell>');
  return context;
}

/** Like useShell, but null outside the shell (pages that render in both places). */
export function useOptionalShell(): ShellContextValue | null {
  return use(ShellContext);
}
