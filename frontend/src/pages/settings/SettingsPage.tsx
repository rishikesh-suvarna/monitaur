import { ChevronRightIcon, PaperAirplaneIcon } from '@heroicons/react/24/outline';
import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { cardClasses } from '../../components/Card';
import { PageBody, PageHeader } from '../../components/layout/PageHeader';
import { useOrgDetails } from '../../hooks/api/org';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { cn } from '../../lib/cn';
import { useReducedMotion } from '../../providers/MotionProvider';

import { ApiEndpointSection, AppearanceSection, DangerZone, ProfileSection, SessionSection } from './AccountSections';
import { OrganizationSection, PlanSection, StatusPageSection } from './OrgSections';

/** The 390 px tab bar has no Channels tab (TabBar.dc.html keeps five), so Settings links to it. */
function ChannelsLink() {
  return (
    <Link
      to="/channels"
      className={cn(cardClasses, 'flex min-h-[64px] items-center gap-3 px-5 py-3 text-ink no-underline hover:bg-surface-2 hover:text-ink')}
    >
      <span className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-surface-3 text-ink-muted">
        <PaperAirplaneIcon className="h-5 w-5" strokeWidth={1.6} aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[16px] font-semibold leading-6">Notification channels</span>
        <span className="text-[12px] leading-4 text-ink-faint">Email, Slack, Discord, Telegram and webhooks</span>
      </span>
      <ChevronRightIcon className="h-5 w-5 flex-none text-ink-faint" strokeWidth={1.8} aria-hidden="true" />
    </Link>
  );
}

/**
 * /settings (Settings.dc.html, SettingsMobile.dc.html), plus the sections the
 * product needs that the design lacks: organisation and members, plan and
 * usage, and the public status page, in the same card language.
 */
export default function SettingsPage() {
  const { hash } = useLocation();
  const reduced = useReducedMotion();
  const desktop = useIsDesktop();
  const details = useOrgDetails();
  const ready = details.data !== undefined;

  // The router does not scroll to #fragments (e.g. /settings#plan from a limit hint).
  useEffect(() => {
    if (hash === '' || !ready) return;
    document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
  }, [hash, ready, reduced]);

  return (
    <>
      <PageHeader title="Settings" />
      <PageBody>
        <div className="flex w-full max-w-[800px] flex-col gap-5">
          {!desktop && <ChannelsLink />}
          <ProfileSection />
          <AppearanceSection />
          <OrganizationSection />
          <PlanSection />
          <StatusPageSection />
          <ApiEndpointSection />
          <SessionSection />
          <DangerZone />
        </div>
      </PageBody>
    </>
  );
}
