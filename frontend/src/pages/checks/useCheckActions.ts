import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { errorMessage, hasErrorCode } from '../../api/errors';
import { queryKeys } from '../../api/queryKeys';
import type { Check, CheckRunResult, ChecksResponse } from '../../api/types';
import { useToast } from '../../components/toastContext';
import { useRunCheck, useUpdateCheck } from '../../hooks/api/checks';
import { useOrg } from '../../providers/OrgProvider';

export const CHECK_VIEWER_REASON = 'Viewers can’t change uptime checks. Ask an admin for the member role.';

export interface CheckActions {
  /** Members and up may create, edit, pause, run and delete. */
  canEdit: boolean;
  disabledReason: string;
  setEnabled: (check: Check, enabled: boolean) => void;
  run: (check: Check) => void;
  isRunning: (checkId: number) => boolean;
  /** The last "Run now" answer per check, shown inline until the next run. */
  results: ReadonlyMap<number, CheckRunResult>;
}

/**
 * Pause/resume (optimistic, rolled back with a toast) and "Run now" with the
 * result kept for inline display. Shared by the list and the detail page.
 */
export function useCheckActions(): CheckActions {
  const { can, orgId } = useOrg();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const update = useUpdateCheck();
  const runner = useRunCheck();
  const [results, setResults] = useState<ReadonlyMap<number, CheckRunResult>>(() => new Map());
  const [running, setRunning] = useState<ReadonlySet<number>>(() => new Set());
  const { mutateAsync: updateAsync } = update;
  const { mutateAsync: runAsync } = runner;

  const setEnabled = useCallback(
    (check: Check, enabled: boolean) => {
      const key = queryKeys.checksList(orgId);
      queryClient.setQueryData<ChecksResponse>(key, (current) =>
        current ? { ...current, checks: current.checks.map((item) => (item.id === check.id ? { ...item, enabled } : item)) } : current,
      );
      updateAsync({ checkId: check.id, body: { enabled } }).catch((error: unknown) => {
        void queryClient.invalidateQueries({ queryKey: key });
        toast({ tone: 'error', title: `Couldn’t ${enabled ? 'resume' : 'pause'} ${check.name}`, description: errorMessage(error) });
      });
    },
    [orgId, queryClient, toast, updateAsync],
  );

  const run = useCallback(
    (check: Check) => {
      setRunning((current) => new Set(current).add(check.id));
      runAsync(check.id)
        .then(({ result }) => {
          setResults((current) => new Map(current).set(check.id, result));
        })
        .catch((error: unknown) => {
          toast({
            tone: 'error',
            title: hasErrorCode(error, 'rate_limited') ? 'Run now is rate limited' : `Couldn’t run ${check.name}`,
            description: hasErrorCode(error, 'rate_limited') ? 'Wait a few seconds and try again.' : errorMessage(error),
          });
        })
        .finally(() => {
          setRunning((current) => {
            const next = new Set(current);
            next.delete(check.id);
            return next;
          });
        });
    },
    [runAsync, toast],
  );

  return {
    canEdit: can('member'),
    disabledReason: CHECK_VIEWER_REASON,
    setEnabled,
    run,
    isRunning: (checkId) => running.has(checkId),
    results,
  };
}
