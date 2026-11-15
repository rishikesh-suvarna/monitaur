import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../../api';
import { queryKeys } from '../../api/queryKeys';
import type { MeResponse, UpdateMeBody } from '../../api/types';
import { useAuth } from '../../providers/AuthProvider';

const ME_STALE_MS = 60_000;

/** GET /me: the user, their orgs and the API's current org. */
export function useMe() {
  const { user } = useAuth();
  const uid = user?.uid ?? '';
  return useQuery({
    queryKey: queryKeys.me(uid),
    queryFn: ({ signal }) => api.me.get(signal),
    enabled: uid !== '',
    staleTime: ME_STALE_MS,
  });
}

export function useUpdateMe() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateMeBody) => api.me.update(body),
    onSuccess: ({ user: updated }) => {
      if (!user) return;
      queryClient.setQueryData<MeResponse>(queryKeys.me(user.uid), (current) =>
        current ? { ...current, user: updated } : current,
      );
    },
  });
}

/** DELETE /me. The caller should sign out afterwards. */
export function useDeleteAccount() {
  return useMutation({ mutationFn: () => api.me.remove() });
}

/** POST /me/sessions/revoke: signs out every other device. */
export function useRevokeSessions() {
  return useMutation({ mutationFn: () => api.me.revokeSessions() });
}

/** POST /invites/accept. Refreshes /me so the new org shows up. */
export function useAcceptInvite() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => api.invites.accept(token),
    onSuccess: async () => {
      if (user) await queryClient.invalidateQueries({ queryKey: queryKeys.me(user.uid) });
    },
  });
}
