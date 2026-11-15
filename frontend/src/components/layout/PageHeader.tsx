import { ChevronLeftIcon } from '@heroicons/react/24/outline';
import type { ReactNode } from 'react';

import { useIsDesktop } from '../../hooks/useMediaQuery';
import { cn } from '../../lib/cn';
import { IconLink } from '../IconButton';
import { Logo } from '../Logo';

export interface PageHeaderProps {
  title: ReactNode;
  /** Desktop line under the title (e.g. the live indicator). */
  description?: ReactNode;
  /** Desktop actions on the right. */
  actions?: ReactNode;
  /** Mobile actions: 44 px icon buttons. */
  mobileActions?: ReactNode;
  /** Mobile back link (detail pages) instead of the logo. */
  back?: { to: string; label: string };
  /** Above the title on desktop (breadcrumb nav). */
  breadcrumb?: ReactNode;
  /** Under the title row (route tabs). */
  children?: ReactNode;
  /** Render the title in mono (server names). */
  monoTitle?: boolean;
}

/**
 * Page header pattern. Desktop (Main.dc.html): 64 px min, 12/32 padding,
 * 20 px title. Mobile (OverviewMobile.dc.html): 56 px bar on surface-1 with the
 * mark (or a back link), a 17 px title and icon actions.
 */
export function PageHeader({ title, description, actions, mobileActions, back, breadcrumb, children, monoTitle = false }: PageHeaderProps) {
  const desktop = useIsDesktop();

  if (!desktop) {
    return (
      <header className="border-b border-line bg-surface-1">
        <div className="flex h-14 items-center gap-2 pl-4 pr-2">
          {back ? (
            <IconLink to={back.to} aria-label={back.label} size="touch" className="-ml-3" icon={<ChevronLeftIcon className="h-5 w-5" strokeWidth={1.8} />} />
          ) : (
            <Logo size={26} wordmark={false} />
          )}
          <h1 className={cn('m-0 ml-1 min-w-0 flex-1 truncate text-[17px] font-semibold', monoTitle && 'num')}>{title}</h1>
          {mobileActions}
        </div>
        {children && <div className="px-4">{children}</div>}
      </header>
    );
  }

  return (
    <header className={cn('flex flex-col border-b border-line px-8', children ? 'gap-3.5 pt-5' : 'py-3')}>
      {breadcrumb}
      <div className="flex min-h-10 flex-wrap items-center gap-4">
        <div className="flex min-w-[200px] flex-1 flex-col gap-0.5">
          <h1 className={cn('m-0 text-h2 font-semibold', monoTitle && 'num')}>{title}</h1>
          {description && <div className="text-[12px] text-ink-faint">{description}</div>}
        </div>
        {actions}
      </div>
      {children}
    </header>
  );
}

/** Page content wrapper: 24/32/48 on desktop, 16 on mobile. */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-col gap-6 p-4 md:px-8 md:pb-12 md:pt-6', className)}>{children}</div>;
}
