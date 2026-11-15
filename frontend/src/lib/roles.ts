import type { Role } from '../api/types';

/** Lowest to highest (docs/platform-v2.md section 4: viewer < member < admin < owner). */
export const ROLES: readonly Role[] = ['viewer', 'member', 'admin', 'owner'];

/** Owner cannot be invited; an owner promotes an accepted member instead. */
export const INVITABLE_ROLES = ['admin', 'member', 'viewer'] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

/** What each role may do (PLAN.md 3.1), for pickers and tooltips. */
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: 'Everything, including roles.',
  admin: 'Members, channels, status page and exports.',
  member: 'Servers, rules and incidents.',
  viewer: 'Read-only.',
};
