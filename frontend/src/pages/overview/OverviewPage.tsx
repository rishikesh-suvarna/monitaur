import { MagnifyingGlassIcon, PlusIcon } from '@heroicons/react/24/outline';
import { useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';

import type { ServerStatus } from '../../api/types';
import { Button, ButtonLink } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { IconButton, IconLink } from '../../components/IconButton';
import { Kbd } from '../../components/Kbd';
import { PageBody, PageHeader } from '../../components/layout/PageHeader';
import { useShell } from '../../components/layout/ShellContext';
import { LiveIndicator } from '../../components/LiveIndicator';
import { CardSkeleton, ServerListSkeleton } from '../../components/Skeletons';
import { useIncidents } from '../../hooks/api/incidents';
import { useServers } from '../../hooks/api/servers';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { ACKED_INCIDENTS, OPEN_INCIDENTS } from '../../hooks/useOpenIncidentCount';
import { useStoredState } from '../../hooks/useStoredState';
import { collectTags, countByStatus, filterServers, SORT_KEYS, sortServers, verdictKind, type SortKey } from '../../lib/fleet';
import { modKeyLabel } from '../../lib/names';
import { breachesByServer, sortActiveIncidents } from '../../lib/status';
import { SESSION_KEYS, STORAGE_KEYS, isBoolean, oneOf, readStored } from '../../lib/storage';
import { useLiveStatus } from '../../providers/LiveStreamProvider';

import { IncidentRail } from './IncidentRail';
import { ServersPanel, type OverviewView } from './ServersPanel';
import { HealthyCard, StatusTiles, VerdictLine } from './Verdict';

/** With the stream up, GET /servers only refreshes sparklines (one minute bucket). */
const SERVERS_REFRESH_LIVE_MS = 60_000;
/** Without the stream, poll so values still move. */
const SERVERS_REFRESH_FALLBACK_MS = 15_000;
const LAST_RESOLVED: { state: 'resolved'; limit: number } = { state: 'resolved', limit: 1 };

const OVERVIEW_VIEWS = ['table', 'grid'] as const;

/** Main.dc.html, OverviewLight.dc.html and OverviewMobile.dc.html. */
export default function OverviewPage() {
  const desktop = useIsDesktop();
  const { openPalette } = useShell();
  const live = useLiveStatus();

  const servers = useServers({ refetchInterval: live.state === 'open' ? SERVERS_REFRESH_LIVE_MS : SERVERS_REFRESH_FALLBACK_MS });
  const open = useIncidents(OPEN_INCIDENTS);
  const acked = useIncidents(ACKED_INCIDENTS);

  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [sort, setSort] = useStoredState<SortKey>(STORAGE_KEYS.overviewSort, 'status', oneOf(SORT_KEYS));
  const [view, setView] = useStoredState<OverviewView>(STORAGE_KEYS.overviewView, 'table', oneOf(OVERVIEW_VIEWS));

  const list = useMemo(() => servers.data?.servers ?? [], [servers.data]);
  const activeIncidents = useMemo(
    () => sortActiveIncidents([...(open.data?.incidents ?? []), ...(acked.data?.incidents ?? [])]),
    [open.data, acked.data],
  );
  const breaches = useMemo(() => breachesByServer(activeIncidents), [activeIncidents]);
  const counts = useMemo(() => countByStatus(list), [list]);
  const tags = useMemo(() => collectTags(list), [list]);
  const rows = useMemo(() => sortServers(filterServers(list, { query, tag, status }), sort), [list, query, tag, status, sort]);
  const allHealthy = verdictKind(counts) === 'healthy';
  const lastResolved = useIncidents(LAST_RESOLVED, { enabled: allHealthy });

  const clearFilters = (): void => {
    setQuery('');
    setTag(null);
    setStatus(null);
  };

  const header = (
    <PageHeader
      brand
      title="Overview"
      description={servers.data ? <LiveIndicator serverCount={list.length} fallbackUpdatedAt={servers.dataUpdatedAt} /> : undefined}
      actions={
        <>
          <Button
            onClick={openPalette}
            aria-haspopup="dialog"
            className="min-w-[260px] justify-start font-normal text-ink-faint"
            leadingIcon={<MagnifyingGlassIcon className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />}
          >
            <span className="flex-1 text-left">Jump to server or action…</span>
            <Kbd>{modKeyLabel('K')}</Kbd>
          </Button>
          <ButtonLink to="/onboarding" variant="primary" leadingIcon={<PlusIcon className="h-4 w-4" strokeWidth={2} aria-hidden="true" />}>
            Add server
          </ButtonLink>
        </>
      }
      mobileActions={
        <>
          <IconButton aria-label="Search servers" size="touch" onClick={openPalette} icon={<MagnifyingGlassIcon className="h-5 w-5" strokeWidth={1.8} />} />
          <IconLink to="/onboarding" aria-label="Add server" size="touch" icon={<PlusIcon className="h-5 w-5" strokeWidth={1.8} />} />
        </>
      }
    />
  );

  if (servers.isPending) {
    return (
      <>
        {header}
        <PageBody>
          <div className="flex flex-wrap items-start gap-6">
            <ServerListSkeleton className="min-w-0 flex-[999_1_640px]" tiles={desktop ? 5 : 4} />
            {desktop && (
              <div className="flex min-w-[280px] max-w-[380px] flex-[1_1_300px] flex-col gap-3">
                <CardSkeleton lines={4} />
                <CardSkeleton lines={4} />
              </div>
            )}
          </div>
        </PageBody>
      </>
    );
  }

  if (servers.isError && !servers.data) {
    return (
      <>
        {header}
        <PageBody>
          <ErrorState error={servers.error} onRetry={() => void servers.refetch()} retrying={servers.isFetching} autoRetryMs={SERVERS_REFRESH_FALLBACK_MS} />
        </PageBody>
      </>
    );
  }

  if (list.length === 0) {
    // First visit with no servers: start onboarding, unless the user skipped it this session.
    if (!readStored(SESSION_KEYS.onboardingDismissed, false, isBoolean, 'session')) return <Navigate to="/onboarding" replace />;
    return (
      <>
        {header}
        <PageBody>
          <EmptyState
            mood="default"
            beatTone="accent"
            dinoSize={desktop ? 200 : 140}
            headingLevel="h2"
            title="No servers yet"
            description="Install the agent on a server and it shows up here within seconds."
            action={
              <ButtonLink to="/onboarding" variant="primary" leadingIcon={<PlusIcon className="h-4 w-4" strokeWidth={2} aria-hidden="true" />}>
                Add your first server
              </ButtonLink>
            }
          />
        </PageBody>
      </>
    );
  }

  const incidentsError = open.error ?? acked.error ?? null;
  const rail = (
    <IncidentRail
      incidents={activeIncidents}
      resolved24h={open.data?.counts.resolved_24h ?? null}
      loading={open.isPending || acked.isPending}
      error={incidentsError}
      onRetry={() => {
        void open.refetch();
        void acked.refetch();
      }}
      compact={!desktop}
    />
  );
  const panel = (
    <ServersPanel
      servers={rows}
      total={list.length}
      breaches={breaches}
      tags={tags}
      query={query}
      onQuery={setQuery}
      tag={tag}
      onTag={setTag}
      sort={sort}
      onSort={setSort}
      view={view}
      onView={setView}
      onClearFilters={clearFilters}
      live={live.state === 'open'}
      compact={!desktop}
    />
  );
  const staleBanner = servers.isError ? (
    <ErrorState
      error={servers.error}
      staleSince={servers.dataUpdatedAt}
      onRetry={() => void servers.refetch()}
      retrying={servers.isFetching}
      autoRetryMs={SERVERS_REFRESH_FALLBACK_MS}
    />
  ) : null;

  if (!desktop) {
    return (
      <>
        {header}
        <PageBody gap="gap-4">
          {staleBanner}
          {allHealthy ? (
            <HealthyCard total={counts.all} lastResolved={lastResolved.data?.incidents[0] ?? null} updatedAt={live.lastServersAt ?? servers.dataUpdatedAt} compact />
          ) : (
            <VerdictLine servers={list} incidents={activeIncidents} compact />
          )}
          <StatusTiles counts={counts} selected={status} onSelect={setStatus} compact />
          {rail}
          {panel}
        </PageBody>
      </>
    );
  }

  return (
    <>
      {header}
      <PageBody>
        {staleBanner}
        {allHealthy ? (
          <HealthyCard total={counts.all} lastResolved={lastResolved.data?.incidents[0] ?? null} updatedAt={live.lastServersAt ?? servers.dataUpdatedAt} />
        ) : (
          <section aria-labelledby="verdict" className="flex flex-wrap items-center gap-x-8 gap-y-4">
            <VerdictLine servers={list} incidents={activeIncidents} />
            <StatusTiles counts={counts} selected={status} onSelect={setStatus} />
          </section>
        )}
        <div className="flex flex-wrap items-start gap-6">
          {panel}
          {rail}
        </div>
      </PageBody>
    </>
  );
}
