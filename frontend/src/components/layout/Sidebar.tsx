import { ChevronLeftIcon, ChevronRightIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { Link, NavLink, useLocation } from 'react-router-dom';

import { useServers } from '../../hooks/api/servers';
import { useOpenIncidentCount } from '../../hooks/useOpenIncidentCount';
import { cn } from '../../lib/cn';
import { compareStatus } from '../../lib/status';
import { modKeyLabel } from '../../lib/names';
import { Kbd } from '../Kbd';
import { Logo } from '../Logo';
import { StatusBadge } from '../StatusBadge';

import { isNavActive, NAV_ITEMS } from './navItems';
import { UserMenu } from './UserMenu';

export interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenPalette: () => void;
}

/**
 * Sidebar.dc.html: logo, "Jump to server", nav with the open-alert count,
 * pinned servers, the user block and the collapse button. 240 px, 64 px
 * collapsed.
 */
export function Sidebar({ collapsed, onToggleCollapsed, onOpenPalette }: SidebarProps) {
  const { pathname } = useLocation();
  const openCount = useOpenIncidentCount();
  const servers = useServers();
  const pinned = (servers.data?.servers ?? [])
    .filter((server) => server.pinned)
    .sort((a, b) => compareStatus(a.status, b.status) || a.name.localeCompare(b.name));
  const open = !collapsed;

  return (
    <nav
      aria-label="Primary"
      className={cn(
        'sticky top-0 flex h-screen flex-none flex-col gap-6 overflow-y-auto border-r border-line bg-surface-1 px-3 py-4 text-[14px]',
        open ? 'w-60' : 'w-16',
      )}
    >
      <Link to="/" className="flex items-center gap-2.5 px-1.5 py-1 text-ink no-underline hover:text-ink">
        <Logo size={28} wordmark={open} />
      </Link>

      <button
        type="button"
        onClick={onOpenPalette}
        aria-haspopup="dialog"
        aria-label={`Jump to server (${modKeyLabel('K')})`}
        className="flex h-9 items-center gap-2 rounded border border-line bg-surface-2 px-2.5 text-left text-[13px] text-ink-muted hover:text-ink"
      >
        <MagnifyingGlassIcon className="h-4 w-4 flex-none" strokeWidth={1.8} aria-hidden="true" />
        {open && (
          <>
            <span className="flex-1">Jump to server</span>
            <Kbd className="bg-transparent px-[5px] py-0.5">{modKeyLabel('K')}</Kbd>
          </>
        )}
      </button>

      <div className="flex flex-col gap-0.5">
        {NAV_ITEMS.map((item) => {
          const active = isNavActive(item, pathname);
          const Icon = item.icon;
          const count = item.key === 'alerts' && openCount !== null && openCount > 0 ? openCount : null;
          return (
            <NavLink
              key={item.key}
              to={item.to}
              aria-current={active ? 'page' : undefined}
              title={open ? undefined : item.label}
              className={cn(
                'flex h-9 items-center gap-2.5 rounded px-2.5 no-underline transition-colors duration-150 ease-out',
                active ? 'bg-surface-3 font-semibold text-ink hover:text-ink' : 'font-medium text-ink-muted hover:bg-surface-2 hover:text-ink',
              )}
            >
              <Icon className="h-[18px] w-[18px] flex-none" strokeWidth={1.6} aria-hidden="true" />
              {open ? <span className="flex-1">{item.label}</span> : <span className="sr-only">{item.label}</span>}
              {count !== null &&
                (open ? (
                  <span className="num inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-tint-crit px-1.5 text-[12px] font-semibold text-crit">
                    {count}
                    <span className="sr-only"> open</span>
                  </span>
                ) : (
                  <span className="sr-only">, {count} open</span>
                ))}
            </NavLink>
          );
        })}
      </div>

      {open && pinned.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="cap px-2.5">Pinned</div>
          {pinned.map((server) => (
            <NavLink
              key={server.id}
              to={`/servers/${server.id}`}
              className="flex h-8 items-center gap-2 rounded px-2.5 text-[13px] text-ink-muted no-underline hover:bg-surface-2 hover:text-ink"
            >
              <StatusBadge status={server.status} variant="icon" size="sm" />
              <span className="truncate">{server.name}</span>
            </NavLink>
          ))}
        </div>
      )}

      <div className="flex-1" />

      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <UserMenu collapsed={collapsed} />
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={open ? 'Collapse sidebar' : 'Expand sidebar'}
          aria-expanded={open}
          className="flex h-8 items-center gap-2 rounded border-0 bg-transparent px-2.5 text-[13px] text-ink-faint hover:bg-surface-2 hover:text-ink"
        >
          {open ? (
            <ChevronLeftIcon className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
          ) : (
            <ChevronRightIcon className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
          )}
          {open && <span>Collapse</span>}
        </button>
      </div>
    </nav>
  );
}
