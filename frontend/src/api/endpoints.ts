import type { ApiClient } from './client';
import type {
  ChannelResponse,
  ChannelsResponse,
  ChannelTestResponse,
  CheckResponse,
  CheckResultsRange,
  CheckResultsResponse,
  CheckRunResponse,
  ChecksResponse,
  CreateChannelBody,
  CreateCheckBody,
  CreateInviteBody,
  CreateInviteResponse,
  CreateMaintenanceBody,
  CreateServerBody,
  CreateServerResponse,
  IncidentFilters,
  IncidentResponse,
  IncidentsResponse,
  MaintenanceResponse,
  MaintenanceWindowResponse,
  Member,
  MembersResponse,
  MeResponse,
  Org,
  OrgResponse,
  ProcessesResponse,
  PublicStatusResponse,
  Role,
  RotateTokenResponse,
  RuleInput,
  RulePreviewResponse,
  RuleResponse,
  RulesResponse,
  SeriesRange,
  SeriesResponse,
  ServerDetailResponse,
  ServerSummary,
  ServersResponse,
  UpdateChannelBody,
  UpdateCheckBody,
  UpdateMaintenanceBody,
  UpdateMeBody,
  UpdateOrgBody,
  UpdateServerBody,
  User,
} from './types';

const SSE_ACCEPT = 'text/event-stream';

const seg = (value: number | string): string => encodeURIComponent(String(value));

/**
 * One typed function per endpoint in docs/platform-v2.md section 4. Org-scoped
 * endpoints take the org id explicitly so the X-Monitaur-Org header always
 * matches the query key the caller caches the result under.
 */
export function createEndpoints(client: ApiClient) {
  const { request } = client;

  return {
    me: {
      get: (signal?: AbortSignal) => request<MeResponse>('/me', { signal }),
      update: (body: UpdateMeBody) => request<{ user: User }>('/me', { method: 'PATCH', body }),
      remove: () => request<undefined>('/me', { method: 'DELETE' }),
      revokeSessions: () => request<undefined>('/me/sessions/revoke', { method: 'POST' }),
    },

    /** Admin-only JSON export of the org, as a downloadable Blob. */
    exportData: async (orgId: number): Promise<Blob> => {
      const response = await client.requestRaw('/export', { orgId, timeoutMs: null });
      return response.blob();
    },

    org: {
      get: (orgId: number, signal?: AbortSignal) => request<OrgResponse>('/org', { orgId, signal }),
      update: (orgId: number, body: UpdateOrgBody) => request<{ org: Org }>('/org', { method: 'PATCH', orgId, body }),
      members: (orgId: number, signal?: AbortSignal) => request<MembersResponse>('/org/members', { orgId, signal }),
      createInvite: (orgId: number, body: CreateInviteBody) =>
        request<CreateInviteResponse>('/org/invites', { method: 'POST', orgId, body }),
      deleteInvite: (orgId: number, inviteId: number) =>
        request<undefined>(`/org/invites/${seg(inviteId)}`, { method: 'DELETE', orgId }),
      updateMember: (orgId: number, userId: number, role: Role) =>
        request<{ member: Member }>(`/org/members/${seg(userId)}`, { method: 'PATCH', orgId, body: { role } }),
      removeMember: (orgId: number, userId: number) =>
        request<undefined>(`/org/members/${seg(userId)}`, { method: 'DELETE', orgId }),
    },

    invites: {
      /** User-level: no org header, the token identifies the org. */
      accept: (token: string) => request<{ org: Org }>('/invites/accept', { method: 'POST', body: { token } }),
    },

    servers: {
      list: (orgId: number, signal?: AbortSignal) => request<ServersResponse>('/servers', { orgId, signal }),
      create: (orgId: number, body: CreateServerBody) =>
        request<CreateServerResponse>('/servers', { method: 'POST', orgId, body }),
      get: (orgId: number, serverId: number, signal?: AbortSignal) =>
        request<ServerDetailResponse>(`/servers/${seg(serverId)}`, { orgId, signal }),
      update: (orgId: number, serverId: number, body: UpdateServerBody) =>
        request<{ server: ServerSummary }>(`/servers/${seg(serverId)}`, { method: 'PATCH', orgId, body }),
      remove: (orgId: number, serverId: number) =>
        request<undefined>(`/servers/${seg(serverId)}`, { method: 'DELETE', orgId }),
      rotateToken: (orgId: number, serverId: number) =>
        request<RotateTokenResponse>(`/servers/${seg(serverId)}/token/rotate`, { method: 'POST', orgId }),
      pin: (orgId: number, serverId: number) =>
        request<undefined>(`/servers/${seg(serverId)}/pin`, { method: 'PUT', orgId }),
      unpin: (orgId: number, serverId: number) =>
        request<undefined>(`/servers/${seg(serverId)}/pin`, { method: 'DELETE', orgId }),
      series: (orgId: number, serverId: number, range: SeriesRange, signal?: AbortSignal) =>
        request<SeriesResponse>(`/servers/${seg(serverId)}/series`, { orgId, query: { range }, signal }),
      /** Section 6.2: the agent's latest process list, from memory. */
      processes: (orgId: number, serverId: number, signal?: AbortSignal) =>
        request<ProcessesResponse>(`/servers/${seg(serverId)}/processes`, { orgId, signal }),
    },

    incidents: {
      list: (orgId: number, filters: IncidentFilters = {}, signal?: AbortSignal) =>
        request<IncidentsResponse>('/incidents', { orgId, signal, query: { ...filters } }),
      ack: (orgId: number, incidentId: number) =>
        request<IncidentResponse>(`/incidents/${seg(incidentId)}/ack`, { method: 'POST', orgId }),
      resolve: (orgId: number, incidentId: number) =>
        request<IncidentResponse>(`/incidents/${seg(incidentId)}/resolve`, { method: 'POST', orgId }),
    },

    rules: {
      list: (orgId: number, signal?: AbortSignal) => request<RulesResponse>('/rules', { orgId, signal }),
      create: (orgId: number, rule: RuleInput) => request<RuleResponse>('/rules', { method: 'POST', orgId, body: rule }),
      update: (orgId: number, ruleId: number, patch: Partial<RuleInput>) =>
        request<RuleResponse>(`/rules/${seg(ruleId)}`, { method: 'PATCH', orgId, body: patch }),
      remove: (orgId: number, ruleId: number) => request<undefined>(`/rules/${seg(ruleId)}`, { method: 'DELETE', orgId }),
      preview: (orgId: number, rule: RuleInput) =>
        request<RulePreviewResponse>('/rules/preview', { method: 'POST', orgId, body: rule }),
    },

    channels: {
      list: (orgId: number, signal?: AbortSignal) => request<ChannelsResponse>('/channels', { orgId, signal }),
      create: (orgId: number, body: CreateChannelBody) =>
        request<ChannelResponse>('/channels', { method: 'POST', orgId, body }),
      update: (orgId: number, channelId: number, body: UpdateChannelBody) =>
        request<ChannelResponse>(`/channels/${seg(channelId)}`, { method: 'PATCH', orgId, body }),
      remove: (orgId: number, channelId: number) =>
        request<undefined>(`/channels/${seg(channelId)}`, { method: 'DELETE', orgId }),
      test: (orgId: number, channelId: number) =>
        request<ChannelTestResponse>(`/channels/${seg(channelId)}/test`, { method: 'POST', orgId }),
    },

    /** Uptime checks (docs/platform-v2.md 6.3). */
    checks: {
      list: (orgId: number, signal?: AbortSignal) => request<ChecksResponse>('/checks', { orgId, signal }),
      create: (orgId: number, body: CreateCheckBody) => request<CheckResponse>('/checks', { method: 'POST', orgId, body }),
      update: (orgId: number, checkId: number, body: UpdateCheckBody) =>
        request<CheckResponse>(`/checks/${seg(checkId)}`, { method: 'PATCH', orgId, body }),
      remove: (orgId: number, checkId: number) => request<undefined>(`/checks/${seg(checkId)}`, { method: 'DELETE', orgId }),
      run: (orgId: number, checkId: number) =>
        request<CheckRunResponse>(`/checks/${seg(checkId)}/run`, { method: 'POST', orgId }),
      results: (orgId: number, checkId: number, range: CheckResultsRange, signal?: AbortSignal) =>
        request<CheckResultsResponse>(`/checks/${seg(checkId)}/results`, { orgId, query: { range }, signal }),
    },

    /** Maintenance windows (docs/platform-v2.md 6.4). */
    maintenance: {
      list: (orgId: number, signal?: AbortSignal) => request<MaintenanceResponse>('/maintenance', { orgId, signal }),
      create: (orgId: number, body: CreateMaintenanceBody) =>
        request<MaintenanceWindowResponse>('/maintenance', { method: 'POST', orgId, body }),
      update: (orgId: number, windowId: number, body: UpdateMaintenanceBody) =>
        request<MaintenanceWindowResponse>(`/maintenance/${seg(windowId)}`, { method: 'PATCH', orgId, body }),
      remove: (orgId: number, windowId: number) =>
        request<undefined>(`/maintenance/${seg(windowId)}`, { method: 'DELETE', orgId }),
    },

    /** Opens the SSE stream (fetch, so the Authorization header can be sent). */
    stream: (orgId: number, signal: AbortSignal) =>
      client.requestRaw('/stream', { orgId, signal, accept: SSE_ACCEPT, timeoutMs: null }),

    publicStatus: (slug: string, signal?: AbortSignal) =>
      request<PublicStatusResponse>(`/public/status/${seg(slug)}`, { auth: false, signal }),
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;
