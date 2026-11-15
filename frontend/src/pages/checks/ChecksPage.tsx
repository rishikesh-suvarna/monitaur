import { PlusIcon } from '@heroicons/react/24/outline';
import { useMemo, useState } from 'react';

import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { IconButton } from '../../components/IconButton';
import { PageBody, PageHeader } from '../../components/layout/PageHeader';
import { LiveIndicator } from '../../components/LiveIndicator';
import { CardSkeleton, TableRowsSkeleton } from '../../components/Skeletons';
import { useChannels } from '../../hooks/api/channels';
import { useChecks } from '../../hooks/api/checks';
import { useOrgDetails } from '../../hooks/api/org';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { countChecksByStatus, sortChecks } from '../../lib/checks';
import { usageLabel } from '../../lib/usage';
import { useLiveStatus } from '../../providers/LiveStreamProvider';

import { CheckDialog } from './CheckDialog';
import { CheckCards, CheckTable } from './CheckList';
import { CHECKS_REFRESH_FALLBACK_MS, CHECKS_REFRESH_LIVE_MS, checkLimits, checkQuota, checksSummary } from './checkModel';
import { useCheckActions } from './useCheckActions';

const SKELETON_CARDS = 3;

/**
 * /checks: uptime checks (docs/platform-v2.md 6.3). No artboard of its own:
 * Main.dc.html's table language, StatusBadge shapes with check words, and
 * States.dc.html empty, loading and error states.
 */
export default function ChecksPage() {
  const desktop = useIsDesktop();
  const live = useLiveStatus();
  const checks = useChecks({ refetchInterval: live.state === 'open' ? CHECKS_REFRESH_LIVE_MS : CHECKS_REFRESH_FALLBACK_MS });
  const channels = useChannels();
  const org = useOrgDetails();
  const actions = useCheckActions();
  const [creating, setCreating] = useState(false);

  const list = useMemo(() => sortChecks(checks.data?.checks ?? []), [checks.data]);
  const counts = useMemo(() => countChecksByStatus(list), [list]);
  const limits = checkLimits(org.data?.plan);
  const quota = checkQuota(org.data?.plan, org.data?.usage, list.length);
  const disabledTitle = actions.canEdit ? undefined : actions.disabledReason;
  // The form preselects enabled channels and the plan's interval, so it opens once both are known.
  const dialogReady = (channels.data !== undefined || channels.isError) && (org.data !== undefined || org.isError);

  const newButton = (
    <Button
      variant="primary"
      leadingIcon={<PlusIcon className="h-4 w-4" strokeWidth={2} aria-hidden="true" />}
      disabled={!actions.canEdit}
      title={disabledTitle}
      onClick={() => {
        setCreating(true);
      }}
    >
      New check
    </Button>
  );

  const header = (
    <PageHeader
      title="Uptime checks"
      description={
        checks.data ? (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <LiveIndicator fallbackUpdatedAt={checks.dataUpdatedAt} />
            <span>{checksSummary(counts)}</span>
          </span>
        ) : undefined
      }
      actions={newButton}
      mobileActions={
        <IconButton
          aria-label="New check"
          size="touch"
          disabled={!actions.canEdit}
          title={disabledTitle ?? 'New check'}
          onClick={() => {
            setCreating(true);
          }}
          icon={<PlusIcon className="h-5 w-5" strokeWidth={1.8} />}
        />
      }
    />
  );

  let body;
  if (checks.isPending) {
    body = desktop ? (
      <Card aria-busy="true" aria-label="Loading uptime checks" className="overflow-hidden">
        <TableRowsSkeleton rows={4} />
      </Card>
    ) : (
      <div aria-busy="true" aria-label="Loading uptime checks" className="flex flex-col gap-2">
        {Array.from({ length: SKELETON_CARDS }, (_, index) => (
          <CardSkeleton key={index} lines={4} />
        ))}
      </div>
    );
  } else if (checks.isError && !checks.data) {
    body = <ErrorState error={checks.error} onRetry={() => void checks.refetch()} retrying={checks.isFetching} autoRetryMs={CHECKS_REFRESH_FALLBACK_MS} />;
  } else if (list.length === 0) {
    body = (
      <EmptyState
        mood="default"
        beatTone="accent"
        dinoSize={desktop ? 180 : 132}
        headingLevel="h2"
        title="No uptime checks yet"
        description="Watch a website, an API, a port or a certificate from outside your servers. Rex pings it every interval."
        action={newButton}
      />
    );
  } else {
    const footer = (
      <>
        <span>
          {quota ? (
            <>
              <span className="num">{usageLabel(quota.used, quota.limit)}</span> checks{quota.planName ? ` on the ${quota.planName} plan` : ''}
            </>
          ) : (
            <>
              <span className="num">{list.length}</span> {list.length === 1 ? 'check' : 'checks'}
            </>
          )}
        </span>
        {live.state === 'open' && <span>Live status every 3 s · two failures in a row open an incident</span>}
      </>
    );
    body = desktop ? <CheckTable checks={list} actions={actions} footer={footer} /> : <CheckCards checks={list} actions={actions} footer={footer} />;
  }

  return (
    <>
      {header}
      <PageBody gap={desktop ? undefined : 'gap-4'}>
        {checks.isError && checks.data && (
          <ErrorState
            variant="widget"
            error={checks.error}
            title="Couldn’t refresh uptime checks. Showing what we have."
            onRetry={() => void checks.refetch()}
            retrying={checks.isFetching}
          />
        )}
        {body}
      </PageBody>
      {creating && dialogReady && (
        <CheckDialog
          check={null}
          channels={channels.data?.channels ?? []}
          limits={limits}
          quota={quota}
          canEdit={actions.canEdit}
          onClose={() => {
            setCreating(false);
          }}
        />
      )}
    </>
  );
}
