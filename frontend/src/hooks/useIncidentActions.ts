import { useCallback } from 'react';

import { errorMessage } from '../api/errors';
import type { Incident } from '../api/types';
import { useToast } from '../components/toastContext';
import { useOrg } from '../providers/OrgProvider';

import { useAckIncident, useResolveIncident } from './api/incidents';

export const INCIDENT_ACTIONS_DISABLED_REASON = 'Viewers can’t acknowledge or resolve incidents. Ask an admin for the member role.';

export interface IncidentActions {
  /** Members and up may acknowledge and resolve. */
  canAct: boolean;
  disabledReason: string;
  ack: (incident: Incident) => void;
  resolve: (incident: Incident) => void;
  isAcking: (incidentId: number) => boolean;
  isResolving: (incidentId: number) => boolean;
}

/**
 * Optimistic Acknowledge / Resolve with a toast on failure (the cache rolls
 * back on its own). Shared by the Alerts page and the server's alert history.
 */
export function useIncidentActions(): IncidentActions {
  const { can } = useOrg();
  const { toast } = useToast();
  const ackMutation = useAckIncident();
  const resolveMutation = useResolveIncident();
  const { mutate: ackMutate } = ackMutation;
  const { mutate: resolveMutate } = resolveMutation;

  const ack = useCallback(
    (incident: Incident) => {
      ackMutate(incident.id, {
        onError: (caught) => {
          toast({ tone: 'error', title: 'Couldn’t acknowledge the incident', description: errorMessage(caught) });
        },
      });
    },
    [ackMutate, toast],
  );

  const resolve = useCallback(
    (incident: Incident) => {
      resolveMutate(incident.id, {
        onError: (caught) => {
          toast({ tone: 'error', title: 'Couldn’t resolve the incident', description: errorMessage(caught) });
        },
      });
    },
    [resolveMutate, toast],
  );

  return {
    canAct: can('member'),
    disabledReason: INCIDENT_ACTIONS_DISABLED_REASON,
    ack,
    resolve,
    isAcking: (incidentId) => ackMutation.isPending && ackMutation.variables === incidentId,
    isResolving: (incidentId) => resolveMutation.isPending && resolveMutation.variables === incidentId,
  };
}
