import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../../api';
import { queryKeys } from '../../api/queryKeys';
import type { CreateInviteBody, OrgResponse, Role, UpdateOrgBody } from '../../api/types';
import { useOrgId } from '../../providers/OrgProvider';

/** GET /org: org settings, plan limits and usage. */
export function useOrgDetails() {
  const orgId = useOrgId();
  return useQuery({
    queryKey: queryKeys.org(orgId),
    queryFn: ({ signal }) => api.org.get(orgId, signal),
  });
}

export function useUpdateOrg() {
  const orgId = useOrgId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateOrgBody) => api.org.update(orgId, body),
    onSuccess: ({ org }) => {
      queryClient.setQueryData<OrgResponse>(queryKeys.org(orgId), (current) => (current ? { ...current, org } : current));
    },
  });
}

/** GET /org/members: members and pending invites. */
export function useMembers() {
  const orgId = useOrgId();
  return useQuery({
    queryKey: queryKeys.members(orgId),
    queryFn: ({ signal }) => api.org.members(orgId, signal),
  });
}

/** Membership changes move the org's usage counters too. */
function useInvalidateMembership() {
  const orgId = useOrgId();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.members(orgId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.org(orgId) }),
    ]);
}

export function useCreateInvite() {
  const orgId = useOrgId();
  const invalidate = useInvalidateMembership();
  return useMutation({
    mutationFn: (body: CreateInviteBody) => api.org.createInvite(orgId, body),
    onSuccess: invalidate,
  });
}

export function useDeleteInvite() {
  const orgId = useOrgId();
  const invalidate = useInvalidateMembership();
  return useMutation({
    mutationFn: (inviteId: number) => api.org.deleteInvite(orgId, inviteId),
    onSuccess: invalidate,
  });
}

export function useUpdateMemberRole() {
  const orgId = useOrgId();
  const invalidate = useInvalidateMembership();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: number; role: Role }) => api.org.updateMember(orgId, userId, role),
    onSuccess: invalidate,
  });
}

/** Removes a member, or leaves the org when `userId` is the current user. */
export function useRemoveMember() {
  const orgId = useOrgId();
  const invalidate = useInvalidateMembership();
  return useMutation({
    mutationFn: (userId: number) => api.org.removeMember(orgId, userId),
    onSuccess: invalidate,
  });
}

/** GET /export: downloads the org export as a JSON file. */
export function useExportData() {
  const orgId = useOrgId();
  return useMutation({
    mutationFn: async () => {
      const blob = await api.exportData(orgId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `monitaur-export-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    },
  });
}
