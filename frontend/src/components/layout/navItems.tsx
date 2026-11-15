import {
  AdjustmentsHorizontalIcon,
  BellIcon,
  GlobeAltIcon,
  PaperAirplaneIcon,
  Squares2X2Icon,
  UserCircleIcon,
} from '@heroicons/react/24/outline';
import type { ComponentType, SVGProps } from 'react';

export type NavKey = 'overview' | 'checks' | 'alerts' | 'rules' | 'channels' | 'settings';

export interface NavItem {
  key: NavKey;
  to: string;
  /** Sidebar label. */
  label: string;
  /** Tab bar label (TabBar.dc.html calls the overview "Servers"). */
  shortLabel: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Routes under this prefix also highlight the item. */
  matches?: readonly string[];
}

export const NAV_ITEMS: readonly NavItem[] = [
  { key: 'overview', to: '/', label: 'Overview', shortLabel: 'Servers', icon: Squares2X2Icon, matches: ['/servers'] },
  { key: 'checks', to: '/checks', label: 'Uptime', shortLabel: 'Uptime', icon: GlobeAltIcon },
  { key: 'alerts', to: '/alerts', label: 'Alerts', shortLabel: 'Alerts', icon: BellIcon },
  { key: 'rules', to: '/rules', label: 'Alert rules', shortLabel: 'Rules', icon: AdjustmentsHorizontalIcon },
  { key: 'channels', to: '/channels', label: 'Channels', shortLabel: 'Channels', icon: PaperAirplaneIcon },
  { key: 'settings', to: '/settings', label: 'Settings', shortLabel: 'Settings', icon: UserCircleIcon },
];

/**
 * TabBar.dc.html keeps five tabs, so the 390 px bar drops Channels and
 * Settings links to it instead (and stays highlighted on /channels).
 */
export const TAB_BAR_ITEMS: readonly NavItem[] = NAV_ITEMS.filter((item) => item.key !== 'channels').map((item) =>
  item.key === 'settings' ? { ...item, matches: ['/channels'] } : item,
);

const underPrefix = (pathname: string, prefix: string): boolean => pathname === prefix || pathname.startsWith(`${prefix}/`);

export function isNavActive(item: NavItem, pathname: string): boolean {
  if (item.to === '/') return pathname === '/' || (item.matches ?? []).some((prefix) => pathname.startsWith(prefix));
  return underPrefix(pathname, item.to) || (item.matches ?? []).some((prefix) => underPrefix(pathname, prefix));
}
