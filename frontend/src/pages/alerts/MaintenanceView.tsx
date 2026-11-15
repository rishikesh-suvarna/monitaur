import { CalendarDaysIcon, CheckCircleIcon, PlusIcon, WrenchScrewdriverIcon } from '@heroicons/react/24/outline';
import { useMemo, useState } from 'react';

import { errorMessage } from '../../api/errors';
import type { MaintenanceState, MaintenanceWindow } from '../../api/types';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { TableRowsSkeleton } from '../../components/Skeletons';
import { useToast } from '../../components/toastContext';
import { useChecks } from '../../hooks/api/checks';
import { useDeleteMaintenance, useMaintenanceWindows, useUpdateMaintenance } from '../../hooks/api/maintenance';
import { useServers } from '../../hooks/api/servers';
import { useNow } from '../../hooks/useNow';
import { cn } from '../../lib/cn';
import { formatDayTime } from '../../lib/format';
import { useOrg } from '../../providers/OrgProvider';

import { MaintenanceDialog } from './MaintenanceDialog';
import { endNowBody, formatWindowLength, groupWindows, maintenanceState, scopeSummary, STATE_LABELS, windowSeconds, windowTiming } from './maintenanceModel';

export const MAINTENANCE_VIEWER_REASON = 'Viewers can’t change maintenance windows. Ask an admin for the member role.';

const STATE_ICON: Record<MaintenanceState, typeof WrenchScrewdriverIcon> = {
  active: WrenchScrewdriverIcon,
  scheduled: CalendarDaysIcon,
  ended: CheckCircleIcon,
};

// Not a health status, so not a StatusBadge shape: accent while active, neutral otherwise.
const STATE_BADGE: Record<MaintenanceState, string> = {
  active: 'border-accent/40 bg-tint-accent text-ink [&>svg]:text-accent',
  scheduled: 'border-line bg-surface-2 text-ink-muted',
  ended: 'border-line bg-transparent text-ink-faint',
};

const STATE_BAR: Record<MaintenanceState, string> = { active: 'bg-accent', scheduled: 'bg-line-strong', ended: 'bg-transparent' };

export function MaintenanceStateBadge({ state }: { state: MaintenanceState }) {
  const Icon = STATE_ICON[state];
  return (
    <span className={cn('inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full border pl-1.5 pr-2 text-[12px] font-semibold leading-none', STATE_BADGE[state])}>
      <Icon className="h-3 w-3 flex-none" strokeWidth={1.8} aria-hidden="true" />
      {STATE_LABELS[state]}
    </span>
  );
}

interface RowProps {
  window: MaintenanceWindow;
  state: MaintenanceState;
  scope: string;
  canEdit: boolean;
  compact: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

function WindowRow({ window, state, scope, canEdit, compact, onEdit, onDelete }: RowProps) {
  const now = useNow();
  const { toast } = useToast();
  const update = useUpdateMaintenance();
  const title = canEdit ? undefined : MAINTENANCE_VIEWER_REASON;
  const touch = compact ? 'h-9' : undefined;

  const endNow = (): void => {
    update.mutate(
      { windowId: window.id, body: endNowBody(Date.now()) },
      {
        onSuccess: () => {
          toast({ tone: 'success', title: `${window.name} ended`, description: 'Notifications are back on for its servers and checks.' });
        },
        onError: (caught) => {
          toast({ tone: 'error', title: `Couldn’t end ${window.name}`, description: errorMessage(caught) });
        },
      },
    );
  };

  return (
    <li className="border-b border-line last:border-b-0">
      <div
        className={cn(
          'grid items-center gap-x-4 gap-y-2.5 py-3 pr-4 transition-colors duration-150 ease-out hover:bg-surface-2',
          compact ? 'grid-cols-[4px_minmax(0,1fr)]' : 'grid-cols-[4px_minmax(0,1fr)_auto]',
        )}
      >
        <span aria-hidden="true" className={cn('self-stretch rounded-r-sm', STATE_BAR[state])} />
        <div className={cn('flex min-w-0 flex-col gap-1.5', state === 'ended' && 'opacity-75')}>
          <div className="flex flex-wrap items-center gap-2">
            <MaintenanceStateBadge state={state} />
            <span className="font-semibold [overflow-wrap:anywhere]">{window.name}</span>
          </div>
          <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[12px] text-ink-muted">
            <span className="num">
              {formatDayTime(window.starts_at, now)} to {formatDayTime(window.ends_at, now)}
            </span>
            <span className="num">{formatWindowLength(windowSeconds(window))}</span>
            <span className={cn('num', state === 'active' && 'text-ink')}>{windowTiming(window, now)}</span>
          </div>
          <span className="text-[12px] text-ink-faint [overflow-wrap:anywhere]">{scope}</span>
        </div>
        <div className={cn('flex flex-wrap gap-2', compact ? 'col-start-2' : 'justify-end')}>
          {state === 'active' && (
            <Button size="sm" className={touch} onClick={endNow} loading={update.isPending} disabled={!canEdit} title={title}>
              End now
            </Button>
          )}
          {state !== 'ended' && (
            <Button size="sm" variant="ghost" className={touch} onClick={onEdit} disabled={!canEdit} title={title}>
              Edit
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className={cn(touch, '!text-crit')}
            onClick={onDelete}
            disabled={!canEdit}
            title={title}
            aria-label={`Delete ${window.name}`}
          >
            Delete
          </Button>
        </div>
      </div>
    </li>
  );
}

/**
 * Alerts › Maintenance (docs/platform-v2.md 6.4): active, scheduled and
 * ended windows. No artboard; built in the Alerts.dc.html row language.
 */
export function MaintenanceView({ compact }: { compact: boolean }) {
  const now = useNow();
  const { can } = useOrg();
  const { toast } = useToast();
  const canEdit = can('member');
  const windows = useMaintenanceWindows();
  const servers = useServers();
  const checks = useChecks();
  const remove = useDeleteMaintenance();
  const [dialog, setDialog] = useState<{ window: MaintenanceWindow | null } | null>(null);
  const [deleting, setDeleting] = useState<MaintenanceWindow | null>(null);

  const serverList = useMemo(() => servers.data?.servers ?? [], [servers.data]);
  // A backend without checks answers 404 here: maintenance still works for servers.
  const checkList = useMemo(() => checks.data?.checks ?? [], [checks.data]);
  const serverNames = useMemo(() => new Map(serverList.map((server) => [server.id, server.name])), [serverList]);
  const checkNames = useMemo(() => new Map(checkList.map((check) => [check.id, check.name])), [checkList]);
  const groups = useMemo(() => groupWindows(windows.data?.windows ?? [], now), [windows.data, now]);
  const dialogReady = (servers.data !== undefined || servers.isError) && (checks.data !== undefined || checks.isError);

  const newButton = (
    <Button
      variant="primary"
      className={compact ? 'h-10' : undefined}
      leadingIcon={<PlusIcon className="h-4 w-4" strokeWidth={2} aria-hidden="true" />}
      disabled={!canEdit}
      title={canEdit ? undefined : MAINTENANCE_VIEWER_REASON}
      onClick={() => {
        setDialog({ window: null });
      }}
    >
      New window
    </Button>
  );

  let body;
  if (windows.isPending) {
    body = (
      <Card aria-busy="true" aria-label="Loading maintenance windows" className="overflow-hidden">
        <TableRowsSkeleton rows={3} />
      </Card>
    );
  } else if (windows.isError && !windows.data) {
    body = <ErrorState error={windows.error} onRetry={() => void windows.refetch()} retrying={windows.isFetching} autoRetryMs={15_000} />;
  } else if (groups.length === 0) {
    body = (
      <Card className="overflow-hidden">
        <EmptyState
          variant="plain"
          mood="sleep"
          dinoSize={compact ? 96 : 120}
          title="No maintenance windows"
          description="Plan one before an upgrade or a reboot so alerts stay quiet while you work."
          action={newButton}
          className="py-8"
        />
      </Card>
    );
  } else {
    body = groups.map((group) => {
      const headingId = `maintenance-group-${group.state}`;
      return (
        <Card key={group.state} as="section" aria-labelledby={headingId} className="overflow-hidden">
          <h2 id={headingId} className="cap m-0 flex items-center gap-2 border-b border-line bg-surface-2 px-4 py-2.5">
            {STATE_LABELS[group.state]} <span className="num">{group.windows.length}</span>
          </h2>
          <ul className="m-0 list-none p-0">
            {group.windows.map((window) => (
              <WindowRow
                key={window.id}
                window={window}
                state={maintenanceState(window, now)}
                scope={scopeSummary(window.scope, serverNames, checkNames)}
                canEdit={canEdit}
                compact={compact}
                onEdit={() => {
                  setDialog({ window });
                }}
                onDelete={() => {
                  remove.reset();
                  setDeleting(window);
                }}
              />
            ))}
          </ul>
        </Card>
      );
    });
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <p className="m-0 min-w-0 flex-[1_1_280px] text-[13px] text-ink-muted">
          During a window, incidents in scope are still recorded and marked <span className="font-medium text-ink">Silenced</span>; no channel is notified.
        </p>
        {groups.length > 0 && newButton}
      </div>
      {windows.isError && windows.data && (
        <ErrorState variant="widget" error={windows.error} title="Couldn’t refresh maintenance windows. Showing what we have." onRetry={() => void windows.refetch()} retrying={windows.isFetching} />
      )}
      {body}
      {dialog && dialogReady && (
        <MaintenanceDialog
          key={dialog.window?.id ?? 'new'}
          existing={dialog.window}
          servers={serverList}
          checks={checkList}
          onClose={() => {
            setDialog(null);
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => {
          setDeleting(null);
        }}
        onConfirm={() => {
          if (!deleting) return;
          const target = deleting;
          remove.mutate(target.id, {
            onSuccess: () => {
              toast({ tone: 'success', title: `${target.name} deleted` });
              setDeleting(null);
            },
          });
        }}
        title={deleting ? `Delete ${deleting.name}?` : 'Delete window?'}
        description={
          deleting && maintenanceState(deleting, now) === 'active'
            ? 'It ends right away and notifications resume. Incidents already marked Silenced stay that way.'
            : 'It is removed from the list. Incidents already marked Silenced stay that way.'
        }
        confirmLabel="Delete window"
        pending={remove.isPending}
        error={remove.error ? errorMessage(remove.error) : undefined}
      />
    </>
  );
}
