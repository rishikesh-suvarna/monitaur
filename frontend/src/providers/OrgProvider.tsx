import { useQueryClient } from '@tanstack/react-query';
import { createContext, use, useCallback, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { queryKeys } from '../api/queryKeys';
import type { MeResponse, OrgMembership, Role, User } from '../api/types';
import { STORAGE_KEYS, isNumber, readStored, writeStored } from '../lib/storage';

const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export function roleAtLeast(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/** The stored org if the user still belongs to it, else the API's current org. */
export function resolveOrg(me: MeResponse, storedId: number | null): OrgMembership | null {
  return (
    me.orgs.find((org) => org.id === storedId) ??
    me.orgs.find((org) => org.id === me.current_org_id) ??
    me.orgs[0] ??
    null
  );
}

export interface OrgContextValue {
  user: User;
  orgs: OrgMembership[];
  org: OrgMembership;
  orgId: number;
  role: Role;
  /** Role check for disabling (not hiding) restricted actions. */
  can: (minimum: Role) => boolean;
  /** Switches org, drops every org-scoped cache entry and goes to the overview. */
  switchOrg: (orgId: number) => void;
}

const OrgContext = createContext<OrgContextValue | null>(null);

interface OrgProviderProps {
  me: MeResponse;
  uid: string;
  children: ReactNode;
}

export function OrgProvider({ me, uid, children }: OrgProviderProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [storedId, setStoredId] = useState<number | null>(() => readStored<number | null>(STORAGE_KEYS.currentOrg, null, isNumber));
  const org = resolveOrg(me, storedId);

  const switchOrg = useCallback(
    (orgId: number) => {
      if (orgId === org?.id) return;
      // queryClient.clear() per the spec, keeping /me so the shell does not flash.
      const meKey = queryKeys.me(uid);
      const cachedMe = queryClient.getQueryData<MeResponse>(meKey);
      queryClient.clear();
      if (cachedMe) queryClient.setQueryData(meKey, cachedMe);
      writeStored(STORAGE_KEYS.currentOrg, orgId);
      setStoredId(orgId);
      void navigate('/');
    },
    [navigate, org?.id, queryClient, uid],
  );

  const value = useMemo<OrgContextValue | null>(() => {
    if (!org) return null;
    return {
      user: me.user,
      orgs: me.orgs,
      org,
      orgId: org.id,
      role: org.role,
      can: (minimum: Role) => roleAtLeast(org.role, minimum),
      switchOrg,
    };
  }, [me.orgs, me.user, org, switchOrg]);

  if (!value) throw new Error('This account does not belong to any organisation.');
  return <OrgContext value={value}>{children}</OrgContext>;
}

export function useOrg(): OrgContextValue {
  const context = use(OrgContext);
  if (!context) throw new Error('useOrg must be used inside <OrgProvider>');
  return context;
}

/** The current org id, for query keys and the X-Monitaur-Org header. */
export function useOrgId(): number {
  return useOrg().orgId;
}
