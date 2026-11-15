import { WrenchScrewdriverIcon } from '@heroicons/react/24/outline';
import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

import type { IncidentCounts, Severity } from '../../api/types';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ChipButton } from '../../components/Chip';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { IncidentRow } from '../../components/IncidentRow';
import { SegmentedControl, type SegmentOption } from '../../components/SegmentedControl';
import { Select, type SelectOption } from '../../components/Select';
import { TableRowsSkeleton } from '../../components/Skeletons';
import { StatusIcon } from '../../components/StatusBadge';
import { useIncidentPages } from '../../hooks/api/incidentPages';
import { useIncidents } from '../../hooks/api/incidents';
import { useMaintenanceWindows } from '../../hooks/api/maintenance';
import { useServers } from '../../hooks/api/servers';
import { useIncidentActions } from '../../hooks/useIncidentActions';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { useNow } from '../../hooks/useNow';
import { OPEN_INCIDENTS } from '../../hooks/useOpenIncidentCount';
import { cn } from '../../lib/cn';

import {
  canMatch,
  DEFAULT_FILTERS,
  groupIncidents,
  isFiltered,
  matchesFilters,
  parseFilters,
  SEVERITIES,
  toApiFilters,
  TYPE_FILTERS,
  TYPE_LABELS,
  writeFilters,
  type AlertFilters,
  type IncidentGroup,
  type StateTab,
} from './filters';
import { IncidentDetails } from './IncidentDetails';
import { maintenanceState } from './maintenanceModel';
import { MaintenanceView } from './MaintenanceView';

/** Select value for "All servers"; server ids start at 1. */
const ALL_SERVERS = 0;
const SEVERITY_LABELS: Record<Severity, string> = { critical: 'Critical', warning: 'Warning' };
const SEVERITY_ICON_CLASS: Record<Severity, string> = { critical: 'text-crit', warning: 'text-warn' };

const EMPTY_COPY: Record<StateTab, { title: string; description: string }> = {
  open: { title: 'No open incidents', description: 'Nothing is over a threshold right now. Rex is napping on the rack.' },
  acked: { title: 'Nothing acknowledged', description: 'Incidents you acknowledge wait here until they resolve.' },
  resolved: { title: 'No resolved incidents yet', description: 'Incidents land here once they recover or someone resolves them.' },
  all: { title: 'No incidents yet', description: 'When a rule fires, the incident shows up here: one row per breach, not per sample.' },
};

/** `?view=maintenance` swaps the incident list for the maintenance windows (F11). */
const VIEW_PARAM = 'view';
const MAINTENANCE_VIEW = 'maintenance';
type HeaderTab = StateTab | typeof MAINTENANCE_VIEW;

const maintenanceLabel = (activeWindows: number | null): string =>
  activeWindows ? `Maintenance windows, ${activeWindows} active` : 'Maintenance windows';

function MaintenanceIcon() {
  return <WrenchScrewdriverIcon className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />;
}

function ActiveCount({ value }: { value: number | null }) {
  return value ? <span className="num text-accent">{value}</span> : null;
}

/** Desktop: Maintenance is a fifth segment beside the incident states. */
function maintenanceOption(activeWindows: number | null): SegmentOption<HeaderTab> {
  return {
    value: MAINTENANCE_VIEW,
    label: 'Maintenance',
    icon: <MaintenanceIcon />,
    suffix: <ActiveCount value={activeWindows} />,
    'aria-label': maintenanceLabel(activeWindows),
  };
}

function stateOptions(counts: IncidentCounts | undefined): SegmentOption<HeaderTab>[] {
  const count = (value: number | undefined) =>
    value === undefined ? null : <span className="num text-ink-faint">{value}</span>;
  return [
    { value: 'open', label: 'Open', suffix: count(counts?.open), 'aria-label': counts ? `Open, ${counts.open}` : 'Open' },
    { value: 'acked', label: 'Acked', suffix: count(counts?.acked), 'aria-label': counts ? `Acknowledged, ${counts.acked}` : 'Acknowledged' },
    {
      value: 'resolved',
      label: 'Resolved',
      suffix: count(counts?.resolved_24h),
      'aria-label': counts ? `Resolved, ${counts.resolved_24h} in the last 24 hours` : 'Resolved',
    },
    { value: 'all', label: 'All' },
  ];
}

function NoMatch({ onClear }: { onClear: () => void }) {
  return (
    <EmptyState
      variant="plain"
      mood="sleep"
      dinoSize={96}
      title="Nothing matches these filters"
      description="Try another severity, type or server."
      action={
        <Button size="sm" onClick={onClear}>
          Clear filters
        </Button>
      }
      className="py-8"
    />
  );
}

interface GroupCardProps {
  group: IncidentGroup;
  compact: boolean;
  expanded: number | null;
  onToggle: (incidentId: number) => void;
  empty: ReactNode;
}

function GroupCard({ group, compact, expanded, onToggle, empty }: GroupCardProps) {
  const actions = useIncidentActions();
  const headingId = `alerts-group-${group.state}`;
  return (
    <Card as="section" aria-labelledby={headingId} className="overflow-hidden [&>div:last-child]:border-b-0">
      <h2 id={headingId} className="cap m-0 flex items-center gap-2 border-b border-line bg-surface-2 px-4 py-2.5">
        {group.label} <span className="num">{group.incidents.length}</span>
      </h2>
      {group.incidents.length === 0 && empty}
      {group.incidents.map((incident) => (
        <IncidentRow
          key={incident.id}
          incident={incident}
          compact={compact}
          onAck={() => {
            actions.ack(incident);
          }}
          onResolve={() => {
            actions.resolve(incident);
          }}
          ackPending={actions.isAcking(incident.id)}
          resolvePending={actions.isResolving(incident.id)}
          canAct={actions.canAct}
          disabledReason={actions.disabledReason}
          expanded={expanded === incident.id}
          onToggleExpanded={() => {
            onToggle(incident.id);
          }}
          details={<IncidentDetails incident={incident} />}
        />
      ))}
    </Card>
  );
}

/** /alerts (Alerts.dc.html, AlertsMobile.dc.html): every incident in the org, one row per incident. */
export default function AlertsPage() {
  const desktop = useIsDesktop();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => parseFilters(params), [params]);
  const maintenance = params.get(VIEW_PARAM) === MAINTENANCE_VIEW;
  const now = useNow();
  const windows = useMaintenanceWindows();
  const activeWindows = windows.data ? windows.data.windows.filter((window) => maintenanceState(window, now) === 'active').length : null;
  const [expanded, setExpanded] = useState<number | null>(null);
  const servers = useServers();
  const sidebarOpen = useIncidents(OPEN_INCIDENTS);
  const matchable = canMatch(filters);
  const pages = useIncidentPages(toApiFilters(filters), { enabled: matchable && !maintenance });
  const counts = pages.counts ?? sidebarOpen.data?.counts;
  const filtered = isFiltered(filters);

  const update = (patch: Partial<AlertFilters>): void => {
    setParams((current) => writeFilters(current, { ...filters, ...patch }), { replace: true });
  };
  const selectTab = (tab: HeaderTab): void => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (tab === MAINTENANCE_VIEW) {
          next.set(VIEW_PARAM, MAINTENANCE_VIEW);
          return next;
        }
        next.delete(VIEW_PARAM);
        return writeFilters(next, { ...filters, state: tab });
      },
      { replace: true },
    );
  };
  const clearFilters = (): void => {
    update({ severities: DEFAULT_FILTERS.severities, type: DEFAULT_FILTERS.type, serverId: DEFAULT_FILTERS.serverId });
  };
  const toggleSeverity = (severity: Severity): void => {
    const on = filters.severities.includes(severity);
    update({ severities: on ? filters.severities.filter((item) => item !== severity) : SEVERITIES.filter((item) => item === severity || filters.severities.includes(item)) });
  };

  const shown = useMemo(() => pages.incidents.filter((incident) => matchesFilters(incident, filters)), [pages.incidents, filters]);
  const groups = matchable ? groupIncidents(shown, filters.state) : groupIncidents([], filters.state === 'all' ? 'open' : filters.state);

  const serverOptions = useMemo<SelectOption<number>[]>(() => {
    const list = [...(servers.data?.servers ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    const options: SelectOption<number>[] = [{ value: ALL_SERVERS, label: 'All servers' }, ...list.map((server) => ({ value: server.id, label: server.name }))];
    if (filters.serverId !== null && !list.some((server) => server.id === filters.serverId)) {
      options.push({ value: filters.serverId, label: `Server ${filters.serverId}` });
    }
    return options;
  }, [servers.data, filters.serverId]);

  const typeOptions = TYPE_FILTERS.map<SelectOption<string>>((type) => ({ value: type, label: TYPE_LABELS[type] }));

  const empty = filtered || !matchable ? (
    <NoMatch onClear={clearFilters} />
  ) : (
    <EmptyState
      variant="plain"
      mood="sleep"
      dinoSize={desktop ? 120 : 96}
      title={EMPTY_COPY[filters.state].title}
      description={EMPTY_COPY[filters.state].description}
      {...(filters.state === 'open'
        ? {
            action: (
              <Button
                size="sm"
                onClick={() => {
                  update({ state: 'resolved' });
                }}
              >
                View resolved
              </Button>
            ),
          }
        : {})}
      className="py-8"
    />
  );

  let body;
  if (matchable && pages.isPending) {
    body = (
      <Card aria-busy="true" aria-label="Loading incidents" className="overflow-hidden">
        <TableRowsSkeleton rows={5} />
      </Card>
    );
  } else if (pages.error !== null && pages.incidents.length === 0) {
    body = <ErrorState error={pages.error} onRetry={pages.refetch} retrying={pages.isFetching} autoRetryMs={15_000} />;
  } else if (groups.length === 0) {
    body = <Card className="overflow-hidden">{empty}</Card>;
  } else {
    body = groups.map((group) => (
      <GroupCard
        key={group.state}
        group={group}
        compact={!desktop}
        expanded={expanded}
        onToggle={(incidentId) => {
          setExpanded((current) => (current === incidentId ? null : incidentId));
        }}
        empty={empty}
      />
    ));
  }

  return (
    <>
      <header
        className={cn(
          'flex flex-wrap items-center gap-3 border-b border-line',
          desktop ? 'min-h-16 px-8 py-3' : 'min-h-14 bg-surface-1 px-4 py-2',
        )}
      >
        <h1 className={cn('m-0 flex-1 font-semibold', desktop ? 'text-h2' : 'text-[18px] leading-6')}>Alerts</h1>
        {/* 390 px has no room for a fifth segment, so Maintenance sits beside the title there. */}
        {!desktop && (
          <ChipButton
            size="touch"
            pressed={maintenance}
            aria-label={maintenanceLabel(activeWindows)}
            onClick={() => {
              selectTab(maintenance ? filters.state : MAINTENANCE_VIEW);
            }}
          >
            <MaintenanceIcon />
            Maintenance
            <ActiveCount value={activeWindows} />
          </ChipButton>
        )}
        <SegmentedControl<HeaderTab>
          aria-label={desktop ? 'Incident state or maintenance' : 'Incident state'}
          value={maintenance ? MAINTENANCE_VIEW : filters.state}
          onChange={selectTab}
          options={desktop ? [...stateOptions(counts), maintenanceOption(activeWindows)] : stateOptions(counts)}
          size={desktop ? 'md' : 'touch'}
        />
      </header>

      {maintenance ? (
        <div className={cn('flex flex-col gap-4', desktop ? 'px-8 pb-12 pt-5' : 'px-3 pb-4 pt-3')}>
          <MaintenanceView compact={!desktop} />
        </div>
      ) : (
        <div className={cn('flex flex-col gap-4', desktop ? 'px-8 pb-12 pt-5' : 'px-3 pb-4 pt-3')}>
          <div role="group" aria-label="Filters" className="flex flex-wrap items-center gap-2">
            {SEVERITIES.map((severity) => (
              <ChipButton
                key={severity}
                size={desktop ? 'lg' : 'touch'}
                pressed={filters.severities.includes(severity)}
                onClick={() => {
                  toggleSeverity(severity);
                }}
              >
                <StatusIcon status={severity} size={12} className={SEVERITY_ICON_CLASS[severity]} />
                {SEVERITY_LABELS[severity]}
              </ChipButton>
            ))}
            <Select<string>
              label="Type"
              hideLabel
              size={desktop ? 'sm' : 'md'}
              value={filters.type}
              options={typeOptions}
              onChange={(type) => {
                update({ type: TYPE_FILTERS.find((item) => item === type) ?? 'all' });
              }}
            />
            <Select<number>
              label="Server"
              hideLabel
              size={desktop ? 'sm' : 'md'}
              value={filters.serverId ?? ALL_SERVERS}
              options={serverOptions}
              onChange={(serverId) => {
                update({ serverId: serverId === ALL_SERVERS ? null : serverId });
              }}
              className="max-w-[260px]"
            />
            {filtered && (
              <Button size="sm" variant="ghost" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
            <span className="flex-1" />
            {desktop && <span className="text-[12px] text-ink-faint">Grouped by incident: a breach that lasts 40 min is one row, not 480 samples.</span>}
          </div>

          {pages.error !== null && pages.incidents.length > 0 && (
            <ErrorState variant="widget" error={pages.error} title="Couldn’t refresh incidents. Showing what we have." onRetry={pages.refetch} retrying={pages.isFetching} />
          )}

          {body}

          {matchable && pages.hasMore && (
            <div className="flex justify-center">
              <Button onClick={pages.loadMore} loading={pages.loadingMore}>
                Load older incidents
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
