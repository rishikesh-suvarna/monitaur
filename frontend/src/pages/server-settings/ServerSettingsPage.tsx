import { useRef } from 'react';
import { useParams } from 'react-router-dom';

import { hasErrorCode } from '../../api/errors';
import type { ServerDetailResponse, ServerSummary } from '../../api/types';
import { ErrorState } from '../../components/ErrorState';
import { PageBody } from '../../components/layout/PageHeader';
import { useDeleteServer } from '../../hooks/api/servers';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { cn } from '../../lib/cn';
import { useOrg } from '../../providers/OrgProvider';
import { parseServerId } from '../server-detail/routes';
import { ServerHeader } from '../server-detail/ServerHeader';
import { ServerBodySkeleton, ServerHeaderSkeleton, ServerNotFound } from '../server-detail/ServerStates';
import { LIST_REFRESH_FALLBACK_MS, useServerSummary } from '../server-detail/useServerSummary';

import { DangerZone } from './DangerZone';
import { GeneralCard } from './GeneralCard';
import { RulesCard } from './RulesCard';
import { TokenCard } from './TokenCard';

interface Snapshot {
  server: ServerSummary;
  detail: ServerDetailResponse;
}

/**
 * /servers/:id/settings (ServerSettings.dc.html, ServerSettingsMobile.dc.html),
 * also the Settings tab of the server page. Viewers see every control
 * disabled with the reason; editing needs member, rotating and deleting admin.
 */
export default function ServerSettingsPage() {
  const desktop = useIsDesktop();
  const { id } = useParams();
  const serverId = parseServerId(id);
  const { can } = useOrg();
  const deleteServer = useDeleteServer();
  // Once the delete is sent, stop refetching the server: it is about to 404.
  const deleting = deleteServer.isPending || deleteServer.isSuccess;
  const { detail, server } = useServerSummary(serverId, !deleting);
  const snapshot = useRef<Snapshot | null>(null);
  if (server && detail.data) snapshot.current = { server, detail: detail.data };
  const shown = deleting ? snapshot.current : server && detail.data ? { server, detail: detail.data } : null;

  if (serverId === null || (!deleting && hasErrorCode(detail.error, 'not_found'))) return <ServerNotFound />;

  if (!shown) {
    if (detail.isError) {
      return (
        <PageBody>
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} retrying={detail.isFetching} autoRetryMs={LIST_REFRESH_FALLBACK_MS} />
        </PageBody>
      );
    }
    return (
      <>
        <ServerHeaderSkeleton desktop={desktop} />
        <ServerBodySkeleton cards={0} />
      </>
    );
  }

  const canEdit = can('member');
  const canAdmin = can('admin');
  const current = shown.server;

  return (
    <>
      <ServerHeader server={current} tab="settings" desktop={desktop} />
      <div className={cn('flex w-full max-w-[800px] flex-col gap-5', desktop ? 'px-8 pb-12 pt-6' : 'p-4')}>
        {detail.isError && !deleting && (
          <ErrorState error={detail.error} staleSince={detail.dataUpdatedAt} onRetry={() => void detail.refetch()} retrying={detail.isFetching} />
        )}
        {/* Keyed by id so moving to another server starts a fresh form. */}
        <GeneralCard key={current.id} server={current} canEdit={canEdit} />
        <RulesCard server={current} canEdit={canEdit} />
        <TokenCard server={current} token={shown.detail.token} canRotate={canAdmin} />
        <DangerZone
          server={current}
          counts={shown.detail.counts}
          canDelete={canAdmin}
          deleting={deleteServer.isPending}
          onDelete={async () => {
            await deleteServer.mutateAsync(current.id);
          }}
        />
      </div>
    </>
  );
}
