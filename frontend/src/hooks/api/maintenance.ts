import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../../api';
import { queryKeys } from '../../api/queryKeys';
import type { CreateMaintenanceBody, UpdateMaintenanceBody } from '../../api/types';
import { useOrgId } from '../../providers/OrgProvider';
import type { PollOptions } from './servers';

/** Windows start and end on their own; refetch now and then so `state` and the maintenance flags stay fresh. */
export const MAINTENANCE_REFRESH_MS = 60_000;

/** GET /maintenance */
export function useMaintenanceWindows(options: PollOptions = {}) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: queryKeys.maintenance(orgId),
    queryFn: ({ signal }) => api.maintenance.list(orgId, signal),
    enabled: options.enabled ?? true,
    refetchInterval: options.refetchInterval ?? MAINTENANCE_REFRESH_MS,
  });
}

/**
 * A window change flips `maintenance` on the servers and checks it covers.
 * The live stream catches up within seconds; refetching makes it immediate.
 */
function useInvalidateMaintenance() {
  const orgId = useOrgId();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.maintenance(orgId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.checksList(orgId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.serversList(orgId) }),
    ]);
}

export function useCreateMaintenance() {
  const orgId = useOrgId();
  const invalidate = useInvalidateMaintenance();
  return useMutation({ mutationFn: (body: CreateMaintenanceBody) => api.maintenance.create(orgId, body), onSuccess: invalidate });
}

/** PATCH /maintenance/:id; "End now" is `{ends_at: now}`. */
export function useUpdateMaintenance() {
  const orgId = useOrgId();
  const invalidate = useInvalidateMaintenance();
  return useMutation({
    mutationFn: ({ windowId, body }: { windowId: number; body: UpdateMaintenanceBody }) => api.maintenance.update(orgId, windowId, body),
    onSuccess: invalidate,
  });
}

export function useDeleteMaintenance() {
  const orgId = useOrgId();
  const invalidate = useInvalidateMaintenance();
  return useMutation({ mutationFn: (windowId: number) => api.maintenance.remove(orgId, windowId), onSuccess: invalidate });
}
