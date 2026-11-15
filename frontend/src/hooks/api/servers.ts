import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../../api';
import { queryKeys } from '../../api/queryKeys';
import type {
  CreateServerBody,
  ServerDetailResponse,
  SeriesRange,
  ServersResponse,
  ServerSummary,
  UpdateServerBody,
} from '../../api/types';
import { useOrgId } from '../../providers/OrgProvider';

export interface PollOptions {
  enabled?: boolean;
  /** ms, or false to rely on the live stream alone. */
  refetchInterval?: number | false;
}

/** GET /servers. Live fields are patched in by useLiveStream between fetches. */
export function useServers(options: PollOptions = {}) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: queryKeys.serversList(orgId),
    queryFn: ({ signal }) => api.servers.list(orgId, signal),
    enabled: options.enabled ?? true,
    refetchInterval: options.refetchInterval ?? false,
  });
}

/** GET /servers/:id */
export function useServer(serverId: number | null, options: PollOptions = {}) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: queryKeys.server(orgId, serverId ?? -1),
    queryFn: ({ signal }) => api.servers.get(orgId, serverId ?? -1, signal),
    enabled: serverId !== null && (options.enabled ?? true),
    refetchInterval: options.refetchInterval ?? false,
  });
}

/**
 * Refresh cadence per range (PLAN.md section 7): live and 1 h every ~10 s,
 * 24 h and longer every ~5 min.
 */
export const SERIES_REFRESH_MS: Record<SeriesRange, number> = {
  live: 10_000,
  '1h': 10_000,
  '6h': 60_000,
  '24h': 300_000,
  '7d': 300_000,
  '30d': 300_000,
};

/**
 * The agent sends a process list every 30 s or more (section 6.2), so a 15 s
 * poll is never more than one list behind.
 */
export const PROCESSES_REFRESH_MS = 15_000;

/**
 * GET /servers/:id/processes, served from memory. Mount it only while the
 * Processes tab is open: it polls while mounted, and TanStack Query pauses the
 * interval while the browser tab is hidden.
 */
export function useServerProcesses(serverId: number | null, options: PollOptions = {}) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: queryKeys.serverProcesses(orgId, serverId ?? -1),
    queryFn: ({ signal }) => api.servers.processes(orgId, serverId ?? -1, signal),
    enabled: serverId !== null && (options.enabled ?? true),
    refetchInterval: options.refetchInterval ?? PROCESSES_REFRESH_MS,
    refetchIntervalInBackground: false,
  });
}

/** GET /servers/:id/series?range= */
export function useServerSeries(serverId: number | null, range: SeriesRange, options: PollOptions = {}) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: queryKeys.serverSeries(orgId, serverId ?? -1, range),
    queryFn: ({ signal }) => api.servers.series(orgId, serverId ?? -1, range, signal),
    enabled: serverId !== null && (options.enabled ?? true),
    refetchInterval: options.refetchInterval ?? SERIES_REFRESH_MS[range],
    // Keep the previous range on screen while the next one loads.
    placeholderData: keepPreviousData,
  });
}

function replaceServer(list: ServersResponse | undefined, server: ServerSummary): ServersResponse | undefined {
  if (!list) return list;
  return { ...list, servers: list.servers.map((item) => (item.id === server.id ? server : item)) };
}

/** POST /servers. The response carries the agent token exactly once. */
export function useCreateServer() {
  const orgId = useOrgId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateServerBody) => api.servers.create(orgId, body),
    onSuccess: async ({ server }) => {
      queryClient.setQueryData<ServersResponse>(queryKeys.serversList(orgId), (current) =>
        current ? { ...current, servers: [...current.servers.filter((item) => item.id !== server.id), server] } : current,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.serversList(orgId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.org(orgId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.rules(orgId) }),
      ]);
    },
  });
}

/** PATCH /servers/:id (name, tags). */
export function useUpdateServer() {
  const orgId = useOrgId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ serverId, body }: { serverId: number; body: UpdateServerBody }) =>
      api.servers.update(orgId, serverId, body),
    onSuccess: async ({ server }) => {
      queryClient.setQueryData<ServersResponse>(queryKeys.serversList(orgId), (current) => replaceServer(current, server));
      queryClient.setQueryData<ServerDetailResponse>(queryKeys.server(orgId, server.id), (current) =>
        current ? { ...current, server } : current,
      );
      // Tag changes alter which rules match the server.
      await queryClient.invalidateQueries({ queryKey: queryKeys.rules(orgId) });
    },
  });
}

/** DELETE /servers/:id */
export function useDeleteServer() {
  const orgId = useOrgId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (serverId: number) => api.servers.remove(orgId, serverId),
    onSuccess: async (_data, serverId) => {
      queryClient.setQueryData<ServersResponse>(queryKeys.serversList(orgId), (current) =>
        current ? { ...current, servers: current.servers.filter((item) => item.id !== serverId) } : current,
      );
      queryClient.removeQueries({ queryKey: queryKeys.server(orgId, serverId) });
      queryClient.removeQueries({ queryKey: queryKeys.serverSeriesAll(orgId, serverId) });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.serversList(orgId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.incidentsAll(orgId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.rules(orgId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.org(orgId) }),
      ]);
    },
  });
}

/** POST /servers/:id/token/rotate. The new token is shown once. */
export function useRotateServerToken() {
  const orgId = useOrgId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (serverId: number) => api.servers.rotateToken(orgId, serverId),
    onSuccess: (_data, serverId) => queryClient.invalidateQueries({ queryKey: queryKeys.server(orgId, serverId) }),
  });
}

/** PUT or DELETE /servers/:id/pin, applied optimistically. */
export function useSetServerPinned() {
  const orgId = useOrgId();
  const queryClient = useQueryClient();
  const listKey = queryKeys.serversList(orgId);
  return useMutation({
    mutationFn: ({ serverId, pinned }: { serverId: number; pinned: boolean }) =>
      pinned ? api.servers.pin(orgId, serverId) : api.servers.unpin(orgId, serverId),
    onMutate: async ({ serverId, pinned }) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous = queryClient.getQueryData<ServersResponse>(listKey);
      queryClient.setQueryData<ServersResponse>(listKey, (current) =>
        current
          ? { ...current, servers: current.servers.map((item) => (item.id === serverId ? { ...item, pinned } : item)) }
          : current,
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(listKey, context.previous);
    },
    onSettled: (_data, _error, { serverId }) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: listKey }),
        queryClient.invalidateQueries({ queryKey: queryKeys.server(orgId, serverId) }),
      ]),
  });
}
