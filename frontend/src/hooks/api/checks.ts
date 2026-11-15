import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../../api';
import { upsertCheck } from '../../api/cachePatches';
import { queryKeys } from '../../api/queryKeys';
import type { CheckResultsRange, ChecksResponse, CreateCheckBody, UpdateCheckBody } from '../../api/types';
import { useOrgId } from '../../providers/OrgProvider';
import type { PollOptions } from './servers';

/** GET /checks. Live fields (status, last result, uptime) are patched in by useLiveStream between fetches. */
export function useChecks(options: PollOptions = {}) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: queryKeys.checksList(orgId),
    queryFn: ({ signal }) => api.checks.list(orgId, signal),
    enabled: options.enabled ?? true,
    refetchInterval: options.refetchInterval ?? false,
  });
}

/** Refresh cadence per results range: 24 h every minute, longer ranges every 5 min (hourly rollups). */
export const CHECK_RESULTS_REFRESH_MS: Record<CheckResultsRange, number> = {
  '24h': 60_000,
  '7d': 300_000,
  '30d': 300_000,
};

/** GET /checks/:id/results?range= */
export function useCheckResults(checkId: number | null, range: CheckResultsRange, options: PollOptions = {}) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: queryKeys.checkResults(orgId, checkId ?? -1, range),
    queryFn: ({ signal }) => api.checks.results(orgId, checkId ?? -1, range, signal),
    enabled: checkId !== null && (options.enabled ?? true),
    refetchInterval: options.refetchInterval ?? CHECK_RESULTS_REFRESH_MS[range],
    // Keep the previous range on screen while the next one loads.
    placeholderData: keepPreviousData,
  });
}

/** POST /checks. Moves the org's check usage. */
export function useCreateCheck() {
  const orgId = useOrgId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCheckBody) => api.checks.create(orgId, body),
    onSuccess: async ({ check }) => {
      queryClient.setQueryData<ChecksResponse>(queryKeys.checksList(orgId), (current) => (current ? upsertCheck(current, check) : current));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.checksList(orgId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.org(orgId) }),
      ]);
    },
  });
}

/** PATCH /checks/:id (also enable/disable). Disabling or retargeting can resolve the check's incidents. */
export function useUpdateCheck() {
  const orgId = useOrgId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ checkId, body }: { checkId: number; body: UpdateCheckBody }) => api.checks.update(orgId, checkId, body),
    onSuccess: async ({ check }) => {
      queryClient.setQueryData<ChecksResponse>(queryKeys.checksList(orgId), (current) => (current ? upsertCheck(current, check) : current));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.checksList(orgId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.incidentsAll(orgId) }),
      ]);
    },
  });
}

/** DELETE /checks/:id. Its incidents go with it (ON DELETE CASCADE). */
export function useDeleteCheck() {
  const orgId = useOrgId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (checkId: number) => api.checks.remove(orgId, checkId),
    onSuccess: async (_data, checkId) => {
      queryClient.setQueryData<ChecksResponse>(queryKeys.checksList(orgId), (current) =>
        current ? { ...current, checks: current.checks.filter((item) => item.id !== checkId) } : current,
      );
      queryClient.removeQueries({ queryKey: queryKeys.checkResultsAll(orgId, checkId) });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.checksList(orgId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.incidentsAll(orgId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.org(orgId) }),
      ]);
    },
  });
}

/** POST /checks/:id/run: one result now (rate limited). The list refetches for the new status. */
export function useRunCheck() {
  const orgId = useOrgId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (checkId: number) => api.checks.run(orgId, checkId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.checksList(orgId) }),
  });
}
