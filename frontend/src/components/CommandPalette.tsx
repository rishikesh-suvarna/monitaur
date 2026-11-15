import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import {
  AdjustmentsHorizontalIcon,
  BellIcon,
  GlobeAltIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  PaperAirplaneIcon,
  PlusIcon,
  Squares2X2Icon,
  SunIcon,
  UserCircleIcon,
} from '@heroicons/react/24/outline';
import { useCallback, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import type { ServerStatus } from '../api/types';
import { useServers } from '../hooks/api/servers';
import { cn } from '../lib/cn';
import { compareStatus } from '../lib/status';
import { useTheme } from '../providers/ThemeProvider';

import { Button } from './Button';
import { Kbd } from './Kbd';
import { StatusBadge } from './StatusBadge';

const MAX_SERVER_RESULTS = 8;
const ICON = 'h-4 w-4 flex-none text-ink-muted';

interface PaletteItem {
  id: string;
  group: 'Servers' | 'Actions';
  label: string;
  /** Extra text matched by search and shown muted (tags, keywords). */
  sub?: string;
  keywords?: string;
  status?: ServerStatus;
  icon?: ReactNode;
  /** Sequence hint, e.g. ["G", "A"]. */
  keys?: readonly string[];
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Main.dc.html command palette: jump to a server or run an action. Arrow keys
 * move, Enter opens, Esc closes. Implemented as a combobox with
 * aria-activedescendant so focus stays in the input.
 */
export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  return (
    <Dialog open={open} onClose={onClose} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-scrim" />
      <div className="fixed inset-0 flex items-start justify-center px-4 pt-[12vh] md:pt-[120px]">
        <DialogPanel className="w-full max-w-[600px] overflow-hidden rounded-xl border border-line-strong bg-surface-1 shadow-float">
          <DialogTitle className="sr-only">Command palette</DialogTitle>
          {open && <PaletteBody onClose={onClose} />}
        </DialogPanel>
      </div>
    </Dialog>
  );
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { resolved, setPreference } = useTheme();
  const servers = useServers();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();

  const go = useCallback(
    (to: string) => () => {
      onClose();
      void navigate(to);
    },
    [navigate, onClose],
  );

  const actions = useMemo<PaletteItem[]>(
    () => [
      { id: 'add-server', group: 'Actions', label: 'Add server', keywords: 'new create onboarding agent', icon: <PlusIcon className={ICON} strokeWidth={1.8} />, run: go('/onboarding') },
      { id: 'go-overview', group: 'Actions', label: 'Go to overview', keywords: 'home servers', icon: <Squares2X2Icon className={ICON} strokeWidth={1.8} />, keys: ['G', 'O'], run: go('/') },
      { id: 'go-checks', group: 'Actions', label: 'Go to uptime checks', keywords: 'http tcp tls ssl certificate ping endpoint monitor', icon: <GlobeAltIcon className={ICON} strokeWidth={1.8} />, keys: ['G', 'U'], run: go('/checks') },
      { id: 'go-alerts', group: 'Actions', label: 'Go to alerts', keywords: 'incidents', icon: <BellIcon className={ICON} strokeWidth={1.8} />, keys: ['G', 'A'], run: go('/alerts') },
      { id: 'go-rules', group: 'Actions', label: 'Go to alert rules', keywords: 'thresholds', icon: <AdjustmentsHorizontalIcon className={ICON} strokeWidth={1.8} />, keys: ['G', 'R'], run: go('/rules') },
      { id: 'go-channels', group: 'Actions', label: 'Go to channels', keywords: 'notifications slack email discord telegram webhook', icon: <PaperAirplaneIcon className={ICON} strokeWidth={1.8} />, keys: ['G', 'C'], run: go('/channels') },
      { id: 'go-settings', group: 'Actions', label: 'Go to settings', keywords: 'profile account', icon: <UserCircleIcon className={ICON} strokeWidth={1.8} />, keys: ['G', 'S'], run: go('/settings') },
      {
        id: 'toggle-theme',
        group: 'Actions',
        label: resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
        keywords: 'theme appearance dark light mode',
        icon: resolved === 'dark' ? <SunIcon className={ICON} strokeWidth={1.8} /> : <MoonIcon className={ICON} strokeWidth={1.8} />,
        run: () => {
          setPreference(resolved === 'dark' ? 'light' : 'dark');
          onClose();
        },
      },
    ],
    [go, resolved, setPreference, onClose],
  );

  const items = useMemo<PaletteItem[]>(() => {
    const needle = query.trim().toLowerCase();
    const matches = (item: PaletteItem): boolean =>
      needle === '' || `${item.label} ${item.sub ?? ''} ${item.keywords ?? ''}`.toLowerCase().includes(needle);
    const serverItems: PaletteItem[] = [...(servers.data?.servers ?? [])]
      .sort((a, b) => compareStatus(a.status, b.status) || a.name.localeCompare(b.name))
      .map((server) => ({
        id: `server-${server.id}`,
        group: 'Servers' as const,
        label: server.name,
        sub: server.tags.join(' · '),
        status: server.status,
        run: go(`/servers/${server.id}`),
      }))
      .filter(matches)
      .slice(0, MAX_SERVER_RESULTS);
    return [...serverItems, ...actions.filter(matches)];
  }, [actions, go, query, servers.data]);

  const activeIndex = items.length === 0 ? -1 : Math.min(active, items.length - 1);
  const optionId = (index: number): string => `${listId}-opt-${index}`;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (items.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((activeIndex + 1) % items.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((activeIndex - 1 + items.length) % items.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActive(items.length - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      items[activeIndex]?.run();
    }
  };

  let lastGroup: PaletteItem['group'] | null = null;

  return (
    <>
      <div className="flex items-center gap-2.5 border-b border-line px-4">
        <MagnifyingGlassIcon className="h-[18px] w-[18px] flex-none text-ink-faint" strokeWidth={1.8} aria-hidden="true" />
        <label htmlFor={`${listId}-input`} className="sr-only">
          Search servers and actions
        </label>
        <input
          id={`${listId}-input`}
          // Headless UI Dialog moves initial focus to the element marked data-autofocus.
          data-autofocus
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Jump to server or action…"
          autoComplete="off"
          spellCheck={false}
          className="h-[52px] flex-1 border-0 bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-faint focus-visible:outline-none"
        />
        <Kbd>esc</Kbd>
      </div>
      <div id={listId} role="listbox" aria-label="Results" className="max-h-[min(60vh,420px)] overflow-y-auto p-2">
        {items.length === 0 && (
          <p className="m-0 px-2.5 py-6 text-center text-[13px] text-ink-muted">
            {servers.isPending ? 'Loading servers…' : `Nothing matches “${query}”.`}
          </p>
        )}
        {items.map((item, index) => {
          const header = item.group !== lastGroup ? item.group : null;
          lastGroup = item.group;
          const selected = index === activeIndex;
          return (
            <div key={item.id} role="presentation">
              {header && (
                <div role="presentation" className={cn('cap px-2.5 pb-1', index === 0 ? 'pt-2' : 'pt-3')}>
                  {header}
                </div>
              )}
              {/* Keyboard selection is handled by the combobox input via aria-activedescendant. */}
              {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events */}
              <div
                id={optionId(index)}
                role="option"
                aria-selected={selected}
                tabIndex={-1}
                onMouseMove={() => {
                  if (!selected) setActive(index);
                }}
                onClick={item.run}
                className={cn('flex h-10 cursor-pointer items-center gap-2.5 rounded px-2.5 text-ink', selected && 'bg-surface-3')}
              >
                {item.status ? <StatusBadge status={item.status} variant="icon" /> : item.icon}
                <span className={cn('truncate', item.status && 'font-medium')}>{item.label}</span>
                {item.sub && <span className="num truncate text-[12px] text-ink-faint">{item.sub}</span>}
                <span className="flex-1" />
                {item.keys?.map((key) => <Kbd key={key}>{key}</Kbd>)}
                {selected && <Kbd>↵</Kbd>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-4 border-t border-line px-4 py-2.5 text-[12px] text-ink-faint">
        <span>
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> move
        </span>
        <span>
          <Kbd>↵</Kbd> open
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </>
  );
}
