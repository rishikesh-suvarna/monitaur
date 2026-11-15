import {
  AdjustmentsHorizontalIcon,
  BellIcon,
  PaperAirplaneIcon,
  Squares2X2Icon,
  UserCircleIcon,
} from '@heroicons/react/24/outline';
import type { ComponentType, SVGProps } from 'react';

export type NavKey = 'overview' | 'alerts' | 'rules' | 'channels' | 'settings';

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
  { key: 'alerts', to: '/alerts', label: 'Alerts', shortLabel: 'Alerts', icon: BellIcon },
  { key: 'rules', to: '/rules', label: 'Alert rules', shortLabel: 'Rules', icon: AdjustmentsHorizontalIcon },
  { key: 'channels', to: '/channels', label: 'Channels', shortLabel: 'Channels', icon: PaperAirplaneIcon },
  { key: 'settings', to: '/settings', label: 'Settings', shortLabel: 'Settings', icon: UserCircleIcon },
];

export function isNavActive(item: NavItem, pathname: string): boolean {
  if (item.to === '/') return pathname === '/' || (item.matches ?? []).some((prefix) => pathname.startsWith(prefix));
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}
