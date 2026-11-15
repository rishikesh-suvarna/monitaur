import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../../api';
import { queryKeys } from '../../api/queryKeys';
import type { RuleInput } from '../../api/types';
import { useOrgId } from '../../providers/OrgProvider';

/** GET /rules, with matched server counts. */
export function useRules() {
  const orgId = useOrgId();
  return useQuery({
    queryKey: queryKeys.rules(orgId),
    queryFn: ({ signal }) => api.rules.list(orgId, signal),
  });
}

/** Rule changes move org usage and can open or resolve incidents. */
function useInvalidateRules() {
  const orgId = useOrgId();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.rules(orgId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.org(orgId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.incidentsAll(orgId) }),
    ]);
}

export function useCreateRule() {
  const orgId = useOrgId();
  const invalidate = useInvalidateRules();
  return useMutation({ mutationFn: (rule: RuleInput) => api.rules.create(orgId, rule), onSuccess: invalidate });
}

export function useUpdateRule() {
  const orgId = useOrgId();
  const invalidate = useInvalidateRules();
  return useMutation({
    mutationFn: ({ ruleId, patch }: { ruleId: number; patch: Partial<RuleInput> }) => api.rules.update(orgId, ruleId, patch),
    onSuccess: invalidate,
  });
}

export function useDeleteRule() {
  const orgId = useOrgId();
  const invalidate = useInvalidateRules();
  return useMutation({ mutationFn: (ruleId: number) => api.rules.remove(orgId, ruleId), onSuccess: invalidate });
}

/** POST /rules/preview: would-be incidents over the last 7 days. Read-only. */
export function usePreviewRule() {
  const orgId = useOrgId();
  return useMutation({ mutationFn: (rule: RuleInput) => api.rules.preview(orgId, rule) });
}
