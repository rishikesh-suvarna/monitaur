import { GlobeAltIcon, ServerIcon } from '@heroicons/react/24/outline';
import { useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';

import { hasErrorCode } from '../../api/errors';
import type { PublicStatusResponse, ServerStatus } from '../../api/types';
import { cardClasses } from '../../components/Card';
import { Dino } from '../../components/Dino';
import { ErrorState } from '../../components/ErrorState';
import { Logo } from '../../components/Logo';
import { Skeleton } from '../../components/Skeletons';
import { StatusBadge } from '../../components/StatusBadge';
import { statusTintClass } from '../../components/statusClasses';
import { usePublicStatus } from '../../hooks/api/publicStatus';
import { useIsDesktop, useMediaQuery } from '../../hooks/useMediaQuery';
import { useNow } from '../../hooks/useNow';
import { cn } from '../../lib/cn';
import { formatClock, formatTimeOfDay } from '../../lib/format';
import { initialsFor } from '../../lib/names';
import { readStored, STORAGE_KEYS } from '../../lib/storage';
import { THEME_PREFERENCES, useTheme, type ThemePreference } from '../../providers/ThemeProvider';

import {
  DAY_HEIGHT_PCT,
  DAY_KIND_LABEL,
  formatUptime,
  incidentView,
  normalizeService,
  pageHeading,
  SERVICE_KIND_LABEL,
  shapeUptimeDays,
  STATUS_WORD,
  statusVerdict,
  uptimeSummary,
  type DayKind,
  type StatusService,
} from './statusModel';

const LIGHT_SCHEME_QUERY = '(prefers-color-scheme: light)';
const REFRESH_SECONDS = 60;
const PROJECT_URL = 'https://github.com/rishikesh-suvarna/monitaur';
const LEGEND_SCALE = 0.14;
const LEGEND_KINDS: readonly DayKind[] = ['ok', 'warn', 'crit', 'none'];

const DAY_FILL: Record<DayKind, string> = { ok: 'bg-ok', warn: 'bg-warn', crit: 'bg-crit', none: 'bg-off' };
/** StatusPage.dc.html hatches "no data" cells with the page background. */
const HATCH = 'repeating-linear-gradient(45deg, transparent 0 2px, rgb(var(--bg)) 2px 3px)';

const BORDER_TONE: Record<ServerStatus, string> = { healthy: 'border-ok', warning: 'border-warn', critical: 'border-crit', offline: 'border-off' };

const isStoredTheme = (value: unknown): value is ThemePreference | null =>
  value === null || (typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value));

/**
 * Visitors of a public page get their OS theme; someone who picked a theme in
 * Monitaur keeps it. Restores the app theme on the way out.
 */
function useStatusPageTheme(): void {
  const { resolved } = useTheme();
  const systemLight = useMediaQuery(LIGHT_SCHEME_QUERY);
  const stored = readStored<ThemePreference | null>(STORAGE_KEYS.theme, null, isStoredTheme);
  const theme = stored === null ? (systemLight ? 'light' : 'dark') : resolved;
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    return () => {
      root.dataset.theme = resolved;
    };
  }, [resolved, theme]);
}

/** /status/:slug (StatusPage.dc.html): public, no auth and no app shell. */
export default function PublicStatusPage() {
  const { slug } = useParams();
  const status = usePublicStatus(slug);
  useStatusPageTheme();
  const notFound = slug === undefined || slug === '' || hasErrorCode(status.error, 'not_found');

  useEffect(() => {
    const previous = document.title;
    document.title = notFound ? 'Status page not found' : status.data ? pageHeading(status.data.title) : 'Status';
    return () => {
      document.title = previous;
    };
  }, [notFound, status.data]);

  return (
    <div className="min-h-screen bg-bg px-4 pb-16 pt-8 text-[14px] text-ink md:px-5 md:pt-12">
      <main className="mx-auto flex max-w-[960px] flex-col gap-7">
        {notFound ? (
          <NotFound />
        ) : status.data ? (
          <StatusContent data={status.data} refreshFailed={status.isRefetchError} />
        ) : status.isError ? (
          <ErrorState
            error={status.error}
            onRetry={() => void status.refetch()}
            retrying={status.isFetching}
            autoRetryMs={REFRESH_SECONDS * 1000}
            title="This status page can’t be loaded right now"
          />
        ) : (
          <StatusSkeleton />
        )}
        <footer className="flex items-center justify-center gap-2 text-[12px] text-ink-faint">
          Powered by
          <a href={PROJECT_URL} className="inline-flex text-ink no-underline hover:text-ink" aria-label="Monitaur">
            <Logo size={18} />
          </a>
        </footer>
      </main>
    </div>
  );
}

function StatusContent({ data, refreshFailed }: { data: PublicStatusResponse; refreshFailed: boolean }) {
  const now = useNow();
  const heading = pageHeading(data.title);
  // Servers and uptime checks (F7) share one list, in the order the page lists them.
  const services = useMemo(() => data.services.map(normalizeService), [data.services]);
  const mixed = services.some((service) => service.kind === 'check') && services.some((service) => service.kind === 'server');
  return (
    <>
      <header className="flex flex-wrap items-center gap-3.5">
        <span aria-hidden="true" className="inline-flex h-10 w-10 flex-none items-center justify-center rounded-lg border border-line-strong font-bold text-ink-muted">
          {initialsFor(data.title)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="m-0 text-[22px] font-semibold leading-7">{heading}</h1>
          <span className="text-[13px] text-ink-muted">Live health of our services</span>
        </div>
      </header>

      <section
        aria-labelledby="status-overall"
        className={cn(cardClasses, 'flex flex-wrap items-center gap-3.5 px-5 py-[18px]', BORDER_TONE[data.overall], statusTintClass(data.overall))}
      >
        <StatusBadge status={data.overall} text={STATUS_WORD[data.overall]} />
        <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-0.5">
          <h2 id="status-overall" className="m-0 text-[16px] font-semibold leading-6">
            {statusVerdict(services)}
          </h2>
          <span className="num text-[12px] text-ink-muted" title={formatClock(data.updated_at)}>
            Updated {formatTimeOfDay(data.updated_at)} · refreshes every {REFRESH_SECONDS} s
            {refreshFailed && <span className="text-warn"> · couldn’t refresh, showing the last update</span>}
          </span>
        </div>
      </section>

      <section aria-labelledby="status-uptime" className={cn(cardClasses, 'overflow-hidden p-0')}>
        <div className="flex flex-wrap items-baseline gap-3 border-b border-line px-5 py-4">
          <h2 id="status-uptime" className="m-0 flex-1 text-[15px] font-semibold">
            Uptime · last 90 days
          </h2>
          <div aria-hidden="true" className="flex flex-wrap gap-3.5 text-[12px] text-ink-muted">
            {LEGEND_KINDS.map((kind) => (
              <span key={kind} className="inline-flex items-end gap-1.5">
                <span
                  className={cn('w-1 rounded-[1px]', DAY_FILL[kind])}
                  style={{ height: `${DAY_HEIGHT_PCT[kind] * LEGEND_SCALE}px`, backgroundImage: kind === 'none' ? HATCH : undefined }}
                />
                {DAY_KIND_LABEL[kind]}
              </span>
            ))}
          </div>
        </div>
        {services.length === 0 ? (
          <p className="m-0 px-5 py-6 text-[13px] text-ink-muted">No services are listed on this page yet.</p>
        ) : (
          services.map((service, index) => <ServiceUptime key={`${service.kind}:${service.name}:${index}`} service={service} showKind={mixed} />)
        )}
      </section>

      <section aria-labelledby="status-incidents" className="flex flex-col gap-3">
        <h2 id="status-incidents" className="m-0 text-[15px] font-semibold">
          Recent incidents
        </h2>
        {data.incidents.length === 0 ? (
          <p className={cn(cardClasses, 'm-0 px-5 py-4 text-[13px] text-ink-muted')}>No incidents in the last 90 days.</p>
        ) : (
          data.incidents.map((incident, index) => {
            const view = incidentView(incident, now);
            return (
              <article key={`${incident.service}:${incident.started_at}:${index}`} className={cn(cardClasses, 'flex flex-col gap-2 px-5 py-4')}>
                <div className="flex flex-wrap items-center gap-2.5">
                  <StatusBadge status={view.status} size="sm" text={view.badge} />
                  <h3 className="m-0 min-w-0 flex-1 text-[14px] font-semibold">{view.title}</h3>
                  <span className="num text-[12px] text-ink-faint">{view.when}</span>
                </div>
                <p className="m-0 text-[13px] text-ink-muted">{view.body}</p>
              </article>
            );
          })
        )}
      </section>
    </>
  );
}

function ServiceUptime({ service, showKind }: { service: StatusService; showKind: boolean }) {
  const desktop = useIsDesktop();
  const cells = useMemo(() => shapeUptimeDays(service.days), [service.days]);
  const KindIcon = service.kind === 'check' ? GlobeAltIcon : ServerIcon;
  return (
    <div className="flex flex-col gap-2.5 border-b border-line px-5 py-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {showKind && (
            <span title={SERVICE_KIND_LABEL[service.kind]} className="inline-flex flex-none text-ink-faint">
              <KindIcon className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />
              <span className="sr-only">{SERVICE_KIND_LABEL[service.kind]}:</span>
            </span>
          )}
          <span className="min-w-0 truncate font-semibold" title={service.name}>
            {service.name}
          </span>
        </span>
        <span className="num text-[13px] text-ink-muted">{formatUptime(service.uptime_pct)} uptime</span>
        <StatusBadge status={service.status} size="sm" text={STATUS_WORD[service.status]} />
      </div>
      <div
        role="img"
        aria-label={uptimeSummary(service, cells)}
        className={cn('grid h-8 grid-cols-[repeat(90,minmax(0,1fr))] items-end', desktop ? 'gap-[2px]' : 'gap-px')}
      >
        {cells.map((cell) => (
          <span
            key={cell.day}
            title={cell.label}
            className={cn('rounded-[1px]', DAY_FILL[cell.kind])}
            style={{ height: `${cell.heightPct}%`, backgroundImage: cell.kind === 'none' ? HATCH : undefined }}
          />
        ))}
      </div>
      <div aria-hidden="true" className="num flex justify-between text-[11px] text-ink-faint">
        <span>90 days ago</span>
        <span>today</span>
      </div>
    </div>
  );
}

function NotFound() {
  const desktop = useIsDesktop();
  return (
    <section aria-labelledby="status-404" className={cn(cardClasses, 'flex flex-wrap items-center justify-center gap-12 px-8 py-14')}>
      <Dino mood="lost" size={desktop ? 280 : 180} beatTone="muted" label="" />
      <div className="flex max-w-[420px] flex-col gap-3">
        <span className="num text-[13px] text-ink-faint">404 · no status page at this address</span>
        <h1 id="status-404" className="m-0 text-display font-semibold tracking-[-0.01em]">
          This status page went extinct.
        </h1>
        <p className="m-0 text-ink-muted">Rex checked every rack. The page may be turned off, or the link is old.</p>
      </div>
    </section>
  );
}

function StatusSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading status" className="flex flex-col gap-7">
      <div className="flex items-center gap-3.5">
        <Skeleton className="h-10 w-10 rounded-lg" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-3 w-1/4" />
        </div>
      </div>
      <Skeleton className="h-[72px] w-full rounded-lg" />
      <div className={cn(cardClasses, 'flex flex-col gap-5 p-5')}>
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="flex flex-col gap-2.5">
            <Skeleton className="h-3.5 w-1/5" />
            <Skeleton className="h-8 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
