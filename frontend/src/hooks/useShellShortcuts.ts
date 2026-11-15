import { useEffect, useRef } from 'react';

/** Max gap between the two keys of a "G then A" sequence. */
export const SEQUENCE_WINDOW_MS = 1000;

/** "G then <key>" navigation (shown in the command palette). */
export const GO_TO_ROUTES: Readonly<Record<string, string>> = {
  o: '/',
  u: '/checks',
  a: '/alerts',
  r: '/rules',
  c: '/channels',
  s: '/settings',
};

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.closest('input, textarea, select, [role="combobox"], [role="textbox"]') !== null;
}

export interface ShellShortcutHandlers {
  onTogglePalette: () => void;
  onNavigate: (to: string) => void;
}

/**
 * Cmd/Ctrl+K toggles the palette; "G" then O/U/A/R/C/S navigates. Owned by
 * <AppShell>: the listener is added when the shell mounts and removed when it
 * unmounts, so sign-in, onboarding and the public status page never see it.
 */
export function useShellShortcuts(handlers: ShellShortcutHandlers): void {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    let sequenceStartedAt: number | null = null;

    const onKeyDown = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && key === 'k') {
        event.preventDefault();
        latest.current.onTogglePalette();
        return;
      }
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;

      if (sequenceStartedAt !== null && event.timeStamp - sequenceStartedAt <= SEQUENCE_WINDOW_MS) {
        sequenceStartedAt = null;
        const to = GO_TO_ROUTES[key];
        if (to !== undefined) {
          event.preventDefault();
          latest.current.onNavigate(to);
        }
        return;
      }
      sequenceStartedAt = key === 'g' ? event.timeStamp : null;
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
