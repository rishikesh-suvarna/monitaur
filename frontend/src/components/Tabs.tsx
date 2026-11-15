import { Tab, TabGroup, TabList, TabPanel, TabPanels } from '@headlessui/react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

import { cn } from '../lib/cn';

// Components.dc.html .tab: 40 px, 2 px accent underline when selected.
const TAB_CLASSES =
  'inline-flex h-10 items-center border-b-2 border-transparent px-[2px] text-[14px] font-medium text-ink-muted no-underline ' +
  'transition-colors duration-150 ease-out hover:text-ink focus-visible:outline-offset-0';
const TAB_SELECTED = 'border-accent text-ink';

export interface TabItem {
  key: string;
  label: ReactNode;
  panel: ReactNode;
}

export interface TabsProps {
  tabs: readonly TabItem[];
  'aria-label': string;
  selectedIndex?: number;
  onChange?: (index: number) => void;
  className?: string;
  panelClassName?: string;
}

/** In-page tabs (Headless UI TabGroup) styled as Components.dc.html .tab. */
export function Tabs({ tabs, selectedIndex, onChange, className, panelClassName, ...rest }: TabsProps) {
  return (
    <TabGroup
      {...(selectedIndex === undefined ? {} : { selectedIndex })}
      {...(onChange ? { onChange } : {})}
      className={className}
    >
      <TabList aria-label={rest['aria-label']} className="flex gap-6">
        {tabs.map((tab) => (
          <Tab key={tab.key} className={cn(TAB_CLASSES, 'data-[selected]:border-accent data-[selected]:text-ink')}>
            {tab.label}
          </Tab>
        ))}
      </TabList>
      <TabPanels className={panelClassName}>
        {tabs.map((tab) => (
          <TabPanel key={tab.key} className="focus-visible:outline-offset-4">
            {tab.panel}
          </TabPanel>
        ))}
      </TabPanels>
    </TabGroup>
  );
}

export interface TabLinkItem {
  to: string;
  label: ReactNode;
  /** Match the path exactly (for an index tab such as Metrics). */
  end?: boolean;
}

/**
 * Route tabs (ServerDetail.dc.html "Metrics / Alerts / Settings"): a nav of
 * links with aria-current, styled like Tabs.
 */
export function TabLinks({ items, 'aria-label': ariaLabel, className }: { items: readonly TabLinkItem[]; 'aria-label': string; className?: string }) {
  return (
    <nav aria-label={ariaLabel} className={cn('flex gap-6', className)}>
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end ?? false}
          className={({ isActive }) => cn(TAB_CLASSES, isActive && TAB_SELECTED)}
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
