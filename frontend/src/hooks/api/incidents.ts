import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { api } from '../../api';
import { patchIncidentsList } from '../../api/cachePatches';
import { queryKeys } from '../../api/queryKeys';
import type { Incident, IncidentFilters, IncidentsResponse, IncidentState } from '../../api/types';
import { useOrgId } from '../../providers/OrgProvider';
import type { PollOptions } from './servers';

/** GET /incidents. Filters are part of the key, so each filter set caches separately. */
export function useIncidents(filters: IncidentFilters = {}, options: PollOptions = {}) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: queryKeys.incidents(orgId, filters),
    queryFn: ({ signal }) => api.incidents.list(orgId, filters, signal),
    enabled: options.enabled ?? true,
    refetchInterval: options.refetchInterval ?? false,
  });
}

/** Folds one updated incident into every cached incidents list of the org. */
export function writeIncidentToCaches(queryClient: QueryClient, orgId: number, incident: Incident): void {
  const previous = findCachedIncident(queryClient, orgId, incident.id);
  for (const [key, data] of queryClient.getQueriesData<IncidentsResponse>({ queryKey: queryKeys.incidentsAll(orgId) })) {
    if (!data) continue;
    const filters = (key[3] ?? {}) as IncidentFilters;
    queryClient.setQueryData<IncidentsResponse>(key, patchIncidentsList(data, filters, incident, previous));
  }
}

export function findCachedIncident(queryClient: QueryClient, orgId: number, incidentId: number): Incident | undefined {
  for (const [, data] of queryClient.getQueriesData<IncidentsResponse>({ queryKey: queryKeys.incidentsAll(orgId) })) {
    const match = data?.incidents.find((item) => item.id === incidentId);
    if (match) return match;
  }
  return undefined;
}

function useIncidentTransition(action: (orgId: number, incidentId: number) => Promise<{ incident: Incident }>, nextState: IncidentState) {
  const orgId = useOrgId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (incidentId: number) => action(orgId, incidentId),
    onMutate: async (incidentId) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.incidentsAll(orgId) });
      const snapshot = queryClient.getQueriesData<IncidentsResponse>({ queryKey: queryKeys.incidentsAll(orgId) });
      const current = findCachedIncident(queryClient, orgId, incidentId);
      if (current) {
        const now = new Date().toISOString();
        writeIncidentToCaches(queryClient, orgId, {
          ...current,
          state: nextState,
          ...(nextState === 'acked' ? { acked_at: now } : { resolved_at: now, resolved_how: 'manual' }),
        });
      }
      return { snapshot };
    },
    onError: (_error, _id, context) => {
      for (const [key, data] of context?.snapshot ?? []) queryClient.setQueryData(key, data);
    },
    onSuccess: ({ incident }) => {
      writeIncidentToCaches(queryClient, orgId, incident);
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.incidentsAll(orgId) }),
        // Resolving can change a server's status and open_incidents.
        nextState === 'resolved' ? queryClient.invalidateQueries({ queryKey: queryKeys.serversList(orgId) }) : null,
      ]),
  });
}

/** POST /incidents/:id/ack (optimistic). */
export function useAckIncident() {
  return useIncidentTransition((orgId, id) => api.incidents.ack(orgId, id), 'acked');
}

/** POST /incidents/:id/resolve (optimistic). */
export function useResolveIncident() {
  return useIncidentTransition((orgId, id) => api.incidents.resolve(orgId, id), 'resolved');
}
