import type { ServerSummary } from '../../api/types';
import { useServer, useServers } from '../../hooks/api/servers';
import { useLiveStatus } from '../../providers/LiveStreamProvider';

/** Without the stream, poll the in-memory servers list so status and values still move. */
export const LIST_REFRESH_FALLBACK_MS = 15_000;

/**
 * GET /servers/:id merged with the servers list entry. The detail is fetched
 * once (it reads counts from the database, so it is never polled; CLAUDE.md
 * "the DB is the bottleneck"). Live fields come from the list entry, which the
 * stream patches every 3 s and which carries the optimistic pin and the live
 * open-incident count; when the stream is down the list is polled instead.
 * `enabled: false` stops fetching, e.g. while the server is being deleted.
 */
export function useServerSummary(serverId: number | null, enabled = true) {
  const live = useLiveStatus();
  const detail = useServer(serverId, { enabled });
  const servers = useServers({ enabled, refetchInterval: live.state === 'open' ? false : LIST_REFRESH_FALLBACK_MS });
  const entry = servers.data?.servers.find((server) => server.id === serverId);
  const data = detail.data;
  let server: ServerSummary | undefined;
  if (data) {
    server = entry
      ? {
          ...data.server,
          status: entry.status,
          connected: entry.connected,
          last_seen: entry.last_seen,
          latest: entry.latest,
          pinned: entry.pinned,
          open_incidents: entry.open_incidents,
          maintenance: entry.maintenance,
        }
      : data.server;
  }
  return { detail, server };
}
