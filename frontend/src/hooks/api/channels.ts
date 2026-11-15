import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../../api';
import { queryKeys } from '../../api/queryKeys';
import type { ChannelsResponse, CreateChannelBody, UpdateChannelBody } from '../../api/types';
import { useOrgId } from '../../providers/OrgProvider';

/** GET /channels */
export function useChannels() {
  const orgId = useOrgId();
  return useQuery({
    queryKey: queryKeys.channels(orgId),
    queryFn: ({ signal }) => api.channels.list(orgId, signal),
  });
}

export function useCreateChannel() {
  const orgId = useOrgId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateChannelBody) => api.channels.create(orgId, body),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.channels(orgId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.org(orgId) }),
      ]),
  });
}

export function useUpdateChannel() {
  const orgId = useOrgId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, body }: { channelId: number; body: UpdateChannelBody }) =>
      api.channels.update(orgId, channelId, body),
    onSuccess: ({ channel }) => {
      queryClient.setQueryData<ChannelsResponse>(queryKeys.channels(orgId), (current) =>
        current ? { channels: current.channels.map((item) => (item.id === channel.id ? channel : item)) } : current,
      );
    },
  });
}

export function useDeleteChannel() {
  const orgId = useOrgId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channelId: number) => api.channels.remove(orgId, channelId),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.channels(orgId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.org(orgId) }),
        // Rules reference channel ids.
        queryClient.invalidateQueries({ queryKey: queryKeys.rules(orgId) }),
      ]),
  });
}

/** POST /channels/:id/test. Refreshes the channel's last-delivery fields. */
export function useTestChannel() {
  const orgId = useOrgId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channelId: number) => api.channels.test(orgId, channelId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.channels(orgId) }),
  });
}
