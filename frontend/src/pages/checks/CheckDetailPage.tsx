import { ChevronLeftIcon, PauseIcon, PencilSquareIcon, PlayIcon } from '@heroicons/react/24/outline';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import type { Channel, Check, CheckResultsRange } from '../../api/types';
import { Button, ButtonLink } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { IconLink } from '../../components/IconButton';
import { MetricCard } from '../../components/MetricCard';
import { RelativeTime } from '../../components/RelativeTime';
import { CardSkeleton, Skeleton } from '../../components/Skeletons';
import { useChannels } from '../../hooks/api/channels';
import { useChecks } from '../../hooks/api/checks';
import { useOrgDetails } from '../../hooks/api/org';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { useNow } from '../../hooks/useNow';
import { channelLabel } from '../../lib/channels';
import { describeResult, formatTlsDays, latencyParts, latencyScaleMax, reportsTls, tlsTone } from '../../lib/checks';
import { cn } from '../../lib/cn';
import { formatDayTime } from '../../lib/format';
import { useLiveStatus } from '../../providers/LiveStreamProvider';
import { formatUptime } from '../status/statusModel';

import { CheckDialog } from './CheckDialog';
import { CheckIncidents } from './CheckIncidents';
import { CheckStatusBadge, CheckTypeChip, MaintenanceChip, RunResultNote } from './CheckBits';
import { CHECKS_REFRESH_FALLBACK_MS, CHECKS_REFRESH_LIVE_MS, checkLimits, checkQuota, checkScheduleLine } from './checkModel';
import { CheckResultsChart } from './CheckResultsChart';
import { useCheckActions, type CheckActions } from './useCheckActions';

const CHECKS_PATH = '/checks';

const parseId = (raw: string | undefined): number | null => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

function channelsLine(ids: readonly number[], channels: readonly Channel[]): string {
  if (ids.length === 0) return 'nobody';
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  return ids.map((id) => {
    const channel = byId.get(id);
    return channel ? channelLabel(channel) : `channel #${id}`;
  }).join(', ');
}

/** "99.98" + "%" for the big readout; the dash stays without a unit. */
function uptimeParts(pct: number | null): { value: string; unit: string | undefined } {
  const text = formatUptime(pct);
  return text.endsWith('%') ? { value: text.slice(0, -1), unit: '%' } : { value: text, unit: undefined };
}

interface HeaderActionsProps {
  check: Check;
  actions: CheckActions;
  onEdit: () => void;
  touch: boolean;
}

function HeaderActions({ check, actions, onEdit, touch }: HeaderActionsProps) {
  const title = actions.canEdit ? undefined : actions.disabledReason;
  const size = touch ? 'h-10' : undefined;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        className={size}
        leadingIcon={<PlayIcon className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />}
        loading={actions.isRunning(check.id)}
        disabled={!actions.canEdit}
        title={title}
        onClick={() => {
          actions.run(check);
        }}
      >
        Run now
      </Button>
      <Button
        className={size}
        leadingIcon={check.enabled ? <PauseIcon className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" /> : <PlayIcon className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />}
        disabled={!actions.canEdit}
        title={title}
        onClick={() => {
          actions.setEnabled(check, !check.enabled);
        }}
      >
        {check.enabled ? 'Pause' : 'Resume'}
      </Button>
      <Button
        className={size}
        variant="ghost"
        leadingIcon={<PencilSquareIcon className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />}
        disabled={!actions.canEdit}
        title={title}
        onClick={onEdit}
      >
        Edit
      </Button>
    </div>
  );
}

function CheckHeader({ check, channels, actions, onEdit, desktop }: { check: Check; channels: readonly Channel[]; actions: CheckActions; onEdit: () => void; desktop: boolean }) {
  const now = useNow();
  const meta = [
    { key: 'target', label: 'Target', value: <span className="num [overflow-wrap:anywhere]">{check.target}</span> },
    { key: 'schedule', label: 'Runs', value: checkScheduleLine(check) },
    { key: 'notify', label: 'Notifies', value: channelsLine(check.channel_ids, channels) },
    {
      key: 'last',
      label: 'Last result',
      value: check.last ? <RelativeTime value={check.last.at} /> : 'none yet',
    },
    { key: 'created', label: 'Created', value: <span className="num">{formatDayTime(check.created_at, now)}</span> },
  ];
  const badges = (
    <>
      <CheckStatusBadge status={check.status} />
      <CheckTypeChip type={check.type} />
      {check.maintenance && <MaintenanceChip />}
    </>
  );

  if (!desktop) {
    return (
      <header className="flex flex-col gap-2.5 border-b border-line bg-surface-1 px-4 pb-3 pt-2">
        <div className="-ml-3 flex items-center gap-1">
          <IconLink to={CHECKS_PATH} aria-label="Back to uptime checks" size="touch" icon={<ChevronLeftIcon className="h-5 w-5" strokeWidth={1.8} />} />
          <h1 className="m-0 min-w-0 flex-1 text-[18px] font-semibold leading-6 [overflow-wrap:anywhere]">{check.name}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">{badges}</div>
        <span className="num text-[12px] text-ink-muted [overflow-wrap:anywhere]">{check.target}</span>
        <HeaderActions check={check} actions={actions} onEdit={onEdit} touch />
      </header>
    );
  }

  return (
    <header className="flex flex-col gap-3.5 border-b border-line px-8 py-5">
      <nav aria-label="Breadcrumb" className="text-[13px] text-ink-faint">
        <Link to={CHECKS_PATH} className="text-ink-muted">
          Uptime
        </Link>{' '}
        <span aria-hidden="true">/</span> <span aria-current="page">{check.name}</span>
      </nav>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <h1 className="m-0 min-w-0 text-h1 font-semibold [overflow-wrap:anywhere]">{check.name}</h1>
        <div className="flex flex-wrap items-center gap-2">{badges}</div>
        <span className="flex-1" />
        <HeaderActions check={check} actions={actions} onEdit={onEdit} touch={false} />
      </div>
      <dl className="m-0 flex flex-wrap gap-x-7 gap-y-2 text-[13px]">
        {meta.map((item) => (
          <div key={item.key} className="flex min-w-0 gap-2">
            <dt className="flex-none text-ink-faint">{item.label}</dt>
            <dd className="m-0 min-w-0 text-ink">{item.value}</dd>
          </div>
        ))}
      </dl>
    </header>
  );
}

function StatCards({ check, compact }: { check: Check; compact: boolean }) {
  const latency = latencyParts(check.last?.latency_ms);
  const uptime = uptimeParts(check.uptime_24h);
  const tls = reportsTls(check);
  const tone = tlsTone(check.tls_days_left, check.tls_warn_days);
  const paused = !check.enabled;
  const density = compact ? 'compact' : 'default';
  const tlsDays = formatTlsDays(check.tls_days_left);
  return (
    <div className={cn('grid gap-3', compact ? 'grid-cols-2' : 'grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4')}>
      <MetricCard
        label="Latency"
        value={latency.value}
        {...(latency.unit ? { unit: latency.unit } : {})}
        values={check.latency_spark}
        sparkMax={latencyScaleMax(check.latency_spark)}
        density={density}
        stale={paused}
        footnote={check.last ? describeResult(check.last) : 'No results yet'}
        {...(check.last && !check.last.ok ? { alert: { status: 'critical' as const, text: 'Failed' } } : {})}
      />
      <MetricCard label="Uptime 24h" value={uptime.value} {...(uptime.unit ? { unit: uptime.unit } : {})} density={density} stale={paused} footnote="Share of results that were up" />
      <MetricCard
        label="Certificate"
        value={tls ? (tlsDays === 'expired' ? 'Expired' : tlsDays.replace(/ d$/, '')) : 'n/a'}
        {...(tls && tlsDays.endsWith(' d') ? { unit: 'days left' } : {})}
        density={density}
        footnote={tls ? `Warns ${check.tls_warn_days} days ahead` : 'Not reported for this target'}
        {...(tone === 'warn' ? { alert: { status: 'warning' as const, text: 'Expiring' } } : {})}
        {...(tone === 'crit' ? { alert: { status: 'critical' as const, text: 'Expired' } } : {})}
      />
      <MetricCard
        label="Open incidents"
        value={String(check.open_incidents)}
        density={density}
        footnote="Two failed results in a row open one"
        {...(check.open_incidents > 0 ? { alert: { status: 'critical' as const, text: 'Open' } } : {})}
      />
    </div>
  );
}

/** /checks/:id: one uptime check with its results chart and incidents. */
export default function CheckDetailPage() {
  const params = useParams();
  const navigate = useNavigate();
  const desktop = useIsDesktop();
  const live = useLiveStatus();
  const checkId = parseId(params.id);
  const checks = useChecks({ refetchInterval: live.state === 'open' ? CHECKS_REFRESH_LIVE_MS : CHECKS_REFRESH_FALLBACK_MS });
  const channels = useChannels();
  const org = useOrgDetails();
  const actions = useCheckActions();
  const [range, setRange] = useState<CheckResultsRange>('24h');
  const [editing, setEditing] = useState(false);
  const check = useMemo(() => checks.data?.checks.find((item) => item.id === checkId) ?? null, [checks.data, checkId]);
  const channelList = channels.data?.channels ?? [];

  if (checks.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading uptime check" className="flex flex-col gap-6 p-4 md:px-8 md:py-6">
        <Skeleton className="h-8 w-1/3" />
        <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
          {Array.from({ length: 4 }, (_, index) => (
            <CardSkeleton key={index} lines={3} />
          ))}
        </div>
        <CardSkeleton lines={6} className="min-h-[280px]" />
      </div>
    );
  }

  if (checks.isError && !checks.data) {
    return (
      <div className="p-4 md:px-8 md:py-6">
        <ErrorState error={checks.error} onRetry={() => void checks.refetch()} retrying={checks.isFetching} autoRetryMs={CHECKS_REFRESH_FALLBACK_MS} />
      </div>
    );
  }

  if (!check) {
    return (
      <div className="p-4 md:px-8 md:py-6">
        <EmptyState
          mood="lost"
          dinoSize={desktop ? 200 : 140}
          headingLevel="h1"
          title="This check went extinct."
          description="Rex looked everywhere. It may have been deleted, or the link is old."
          action={<ButtonLink to={CHECKS_PATH}>Back to uptime checks</ButtonLink>}
        />
      </div>
    );
  }

  const result = actions.results.get(check.id);
  const quota = checkQuota(org.data?.plan, org.data?.usage, checks.data.checks.length);

  return (
    <>
      <CheckHeader
        check={check}
        channels={channelList}
        actions={actions}
        desktop={desktop}
        onEdit={() => {
          setEditing(true);
        }}
      />
      <div className={cn('flex flex-col', desktop ? 'gap-6 px-8 pb-12 pt-6' : 'gap-4 p-4')}>
        {checks.isError && (
          <ErrorState variant="widget" error={checks.error} title="Couldn’t refresh this check. Showing what we have." onRetry={() => void checks.refetch()} retrying={checks.isFetching} />
        )}
        {result && <RunResultNote result={result} />}
        {check.maintenance && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-surface-1 px-3.5 py-3 text-[13px] text-ink-muted">
            <MaintenanceChip />
            <p className="m-0 min-w-0 flex-[1_1_240px]">A maintenance window covers this check: incidents are still recorded, but nobody is notified.</p>
            <Link to="/alerts?view=maintenance" className="flex-none">
              See maintenance windows
            </Link>
          </div>
        )}
        <StatCards check={check} compact={!desktop} />
        <CheckResultsChart checkId={check.id} range={range} onRange={setRange} compact={!desktop} />
        <CheckIncidents checkId={check.id} compact={!desktop} />
      </div>
      {editing && (
        <CheckDialog
          check={check}
          channels={channelList}
          limits={checkLimits(org.data?.plan)}
          quota={quota}
          canEdit={actions.canEdit}
          onClose={() => {
            setEditing(false);
          }}
          onDeleted={() => {
            void navigate(CHECKS_PATH, { replace: true });
          }}
        />
      )}
    </>
  );
}
