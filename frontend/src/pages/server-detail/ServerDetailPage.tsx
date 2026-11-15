import { useParams, useSearchParams } from 'react-router-dom';

import { hasErrorCode } from '../../api/errors';
import { ErrorState } from '../../components/ErrorState';
import { PageBody } from '../../components/layout/PageHeader';
import { useIsDesktop } from '../../hooks/useMediaQuery';

import { AlertHistory } from './AlertHistory';
import { MetricsTab } from './MetricsTab';
import { ProcessesTab } from './ProcessesTab';
import { parseServerId, parseTab, TAB_PARAM } from './routes';
import { ServerHeader } from './ServerHeader';
import { ServerBodySkeleton, ServerHeaderSkeleton, ServerNotFound } from './ServerStates';
import { LIST_REFRESH_FALLBACK_MS, useServerSummary } from './useServerSummary';

/**
 * /servers/:id (ServerDetail.dc.html, ServerDetailLight.dc.html,
 * ServerDetailMobile.dc.html). Metrics, Processes and Alerts share the route
 * and differ by `?tab=`; Settings is /servers/:id/settings.
 */
export default function ServerDetailPage() {
  const desktop = useIsDesktop();
  const { id } = useParams();
  const [params] = useSearchParams();
  const serverId = parseServerId(id);
  const tab = parseTab(params.get(TAB_PARAM));
  const { detail, server } = useServerSummary(serverId);

  if (serverId === null || hasErrorCode(detail.error, 'not_found')) return <ServerNotFound />;

  if (!server) {
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
        <ServerBodySkeleton />
      </>
    );
  }

  return (
    <>
      <ServerHeader server={server} tab={tab} desktop={desktop} />
      <PageBody gap={desktop ? 'gap-5' : 'gap-3.5'} padding={desktop ? 'px-8 pb-12 pt-5' : 'p-3'}>
        {detail.isError && (
          <ErrorState error={detail.error} staleSince={detail.dataUpdatedAt} onRetry={() => void detail.refetch()} retrying={detail.isFetching} />
        )}
        {tab === 'metrics' && <MetricsTab server={server} desktop={desktop} />}
        {tab === 'processes' && <ProcessesTab server={server} desktop={desktop} />}
        {tab === 'alerts' && <AlertHistory serverId={server.id} mode="full" compact={!desktop} />}
      </PageBody>
    </>
  );
}
