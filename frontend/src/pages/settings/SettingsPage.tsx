import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

import { PageBody, PageHeader } from '../../components/layout/PageHeader';
import { useOrgDetails } from '../../hooks/api/org';
import { useReducedMotion } from '../../providers/MotionProvider';

import { ApiEndpointSection, AppearanceSection, DangerZone, ProfileSection, SessionSection } from './AccountSections';
import { OrganizationSection, PlanSection, StatusPageSection } from './OrgSections';

/**
 * /settings (Settings.dc.html, SettingsMobile.dc.html), plus the sections the
 * product needs that the design lacks: organisation and members, plan and
 * usage, and the public status page, in the same card language.
 */
export default function SettingsPage() {
  const { hash } = useLocation();
  const reduced = useReducedMotion();
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
