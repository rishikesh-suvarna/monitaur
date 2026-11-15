import { Suspense, useCallback, useMemo, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';

import { useIsDesktop } from '../../hooks/useMediaQuery';
import { useShellShortcuts } from '../../hooks/useShellShortcuts';
import { useStoredState } from '../../hooks/useStoredState';
import { isBoolean, STORAGE_KEYS } from '../../lib/storage';
import { CommandPalette } from '../CommandPalette';
import { Loader } from '../Loader';

import { ShellContext } from './ShellContext';
import { Sidebar } from './Sidebar';
import { TabBar } from './TabBar';

function PageFallback() {
  return (
    <div className="flex flex-1 items-center justify-center p-12 text-accent">
      <Loader size={48} label="Loading page" />
    </div>
  );
}

/**
 * The signed-in layout: collapsible sidebar on desktop, tab bar under
 * 768 px, the command palette, and the keyboard shortcuts.
 */
export function AppShell() {
  const desktop = useIsDesktop();
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [collapsed, setCollapsed] = useStoredState(STORAGE_KEYS.sidebarCollapsed, false, isBoolean);

  const openPalette = useCallback(() => {
    setPaletteOpen(true);
  }, []);
  const closePalette = useCallback(() => {
    setPaletteOpen(false);
  }, []);

  useShellShortcuts({
    onTogglePalette: () => {
      setPaletteOpen((current) => !current);
    },
    onNavigate: (to) => {
      void navigate(to);
    },
  });

  const shell = useMemo(() => ({ openPalette }), [openPalette]);

  return (
    <ShellContext value={shell}>
      <a
        href="#main"
        className="sr-only z-50 rounded bg-accent no-underline px-3 py-2 font-semibold text-accent-ink focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>
      <div className="flex min-h-screen bg-bg">
        {desktop && (
          <Sidebar
            collapsed={collapsed}
            onToggleCollapsed={() => {
              setCollapsed(!collapsed);
            }}
            onOpenPalette={openPalette}
          />
        )}
        <main id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col pb-[calc(84px+env(safe-area-inset-bottom))] focus:outline-none md:pb-0">
          <Suspense fallback={<PageFallback />}>
            <Outlet />
          </Suspense>
        </main>
        {!desktop && <TabBar />}
      </div>
      <CommandPalette open={paletteOpen} onClose={closePalette} />
    </ShellContext>
  );
}
