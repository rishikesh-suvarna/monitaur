import { NavLink, useLocation } from 'react-router-dom';

import { useOpenIncidentCount } from '../../hooks/useOpenIncidentCount';
import { cn } from '../../lib/cn';

import { isNavActive, NAV_ITEMS } from './navItems';

/** Height of the tab bar above the safe area (TabBar.dc.html is 84 incl. 22 bottom). */
export const TAB_BAR_HEIGHT_PX = 84;

/** TabBar.dc.html: five tabs on mobile (< 768 px), accent when current. */
export function TabBar() {
  const { pathname } = useLocation();
  const openCount = useOpenIncidentCount();

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-line bg-surface-1 px-2 pt-1.5 pb-[max(22px,env(safe-area-inset-bottom))]"
    >
      {NAV_ITEMS.map((item) => {
        const active = isNavActive(item, pathname);
        const Icon = item.icon;
        const count = item.key === 'alerts' && openCount !== null && openCount > 0 ? openCount : null;
        return (
          <NavLink
            key={item.key}
            to={item.to}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative flex min-h-[52px] flex-col items-center justify-center gap-1 text-[11px] no-underline',
              active ? 'font-semibold text-accent hover:text-accent' : 'font-medium text-ink-muted hover:text-ink',
            )}
          >
            <Icon className="h-[22px] w-[22px]" strokeWidth={1.6} aria-hidden="true" />
            <span>{item.shortLabel}</span>
            {count !== null && (
              <span className="num absolute left-[calc(50%+6px)] top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-crit px-1 text-[10px] font-semibold text-bg">
                {count}
                <span className="sr-only"> open</span>
              </span>
            )}
          </NavLink>
        );
      })}
    </nav>
  );
}
