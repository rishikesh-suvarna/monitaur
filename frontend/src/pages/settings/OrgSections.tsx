import { ArrowTopRightOnSquareIcon, UserPlusIcon } from '@heroicons/react/24/outline';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';

import { errorMessage, hasErrorCode, isApiError } from '../../api/errors';
import { queryKeys } from '../../api/queryKeys';
import type { Member, Org, Role, ServerSummary } from '../../api/types';
import { Button } from '../../components/Button';
import { buttonClasses } from '../../components/buttonClasses';
import { Chip, ChipButton } from '../../components/Chip';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorState } from '../../components/ErrorState';
import { Input } from '../../components/Input';
import { hintClasses, labelClasses } from '../../components/inputClasses';
import { RoleBadge } from '../../components/RoleBadge';
import { Select } from '../../components/Select';
import { Skeleton } from '../../components/Skeletons';
import { StatusIcon } from '../../components/StatusBadge';
import { useToast } from '../../components/toastContext';
import { Toggle } from '../../components/Toggle';
import { UsageMeter } from '../../components/UsageMeter';
import { useDeleteInvite, useMembers, useOrgDetails, useRemoveMember, useUpdateMemberRole, useUpdateOrg } from '../../hooks/api/org';
import { useServers } from '../../hooks/api/servers';
import { useNow } from '../../hooks/useNow';
import { cn } from '../../lib/cn';
import { formatRelativeTime } from '../../lib/format';
import { initialsFor } from '../../lib/names';
import { ROLE_LABELS, ROLES } from '../../lib/roles';
import { useAuth } from '../../providers/AuthProvider';
import { useOrg } from '../../providers/OrgProvider';

import { InviteDialog } from './InviteDialog';
import { CopyField, InlineSave, SettingsCard } from './SettingsCard';
import {
  inviteExpiry,
  MAX_ORG_NAME_LENGTH,
  MAX_STATUS_TITLE_LENGTH,
  memberPermissions,
  normalizeSlug,
  retentionText,
  slugError,
  statusPageDirty,
  statusPageForm,
  statusPagePatch,
  statusPageUrl,
  STATUS_PATH_PREFIX,
  type StatusPageForm,
} from './settingsModel';

const ADMIN_ONLY = 'Only admins can change this';
const ROLE_OPTIONS = [...ROLES].reverse().map((role) => ({ value: role, label: ROLE_LABELS[role] }));

function useInvalidateMe() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  return () => (user ? queryClient.invalidateQueries({ queryKey: queryKeys.me(user.uid) }) : Promise.resolve());
}

// ---------------------------------------------------------------- organization

export function OrganizationSection() {
  const { org, role, can } = useOrg();
  const isAdmin = can('admin');
  const [inviting, setInviting] = useState(false);
  return (
    <SettingsCard
      title="Organization"
      description={org.personal ? 'Your personal organisation. Invite people to share its servers.' : 'Everyone here shares servers, rules and channels.'}
      aside={<RoleBadge role={role} />}
    >
      <OrgNameForm key={org.id} org={org.name} canEdit={isAdmin} />
      <MembersList
        onInvite={() => {
          setInviting(true);
        }}
      />
      {inviting && (
        <InviteDialog
          orgName={org.name}
          onClose={() => {
            setInviting(false);
          }}
        />
      )}
    </SettingsCard>
  );
}

function OrgNameForm({ org, canEdit }: { org: string; canEdit: boolean }) {
  const { toast } = useToast();
  const update = useUpdateOrg();
  const invalidateMe = useInvalidateMe();
  const [saved, setSaved] = useState(org);
  const [name, setName] = useState(org);
  const dirty = name.trim() !== saved && name.trim() !== '';

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!dirty || !canEdit) return;
    update.mutate(
      { name: name.trim() },
      {
        onSuccess: ({ org: next }) => {
          setSaved(next.name);
          setName(next.name);
          void invalidateMe();
          toast({ title: 'Organisation renamed', description: next.name, tone: 'success' });
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className="max-w-[420px]">
      <Input
        label="Name"
        size="lg"
        value={name}
        maxLength={MAX_ORG_NAME_LENGTH}
        disabled={!canEdit}
        title={canEdit ? undefined : ADMIN_ONLY}
        error={update.error ? errorMessage(update.error) : undefined}
        className={cn(dirty && 'pr-[72px]')}
        onChange={(event) => {
          setName(event.target.value);
          if (update.error) update.reset();
        }}
        trailing={dirty ? <InlineSave visible pending={update.isPending} /> : undefined}
      />
    </form>
  );
}

interface PendingRemoval {
  member: Member;
  self: boolean;
}

function MembersList({ onInvite }: { onInvite: () => void }) {
  const { user, org, orgId, orgs, role, can, switchOrg } = useOrg();
  const now = useNow();
  const { toast } = useToast();
  const members = useMembers();
  const updateRole = useUpdateMemberRole();
  const removeMember = useRemoveMember();
  const deleteInvite = useDeleteInvite();
  const invalidateMe = useInvalidateMe();
  const [removal, setRemoval] = useState<PendingRemoval | null>(null);
  const isAdmin = can('admin');
  const viewer = { userId: user.id, role, personalOrg: org.personal };

  const changeRole = (member: Member, next: Role): void => {
    if (next === member.role) return;
    updateRole.mutate(
      { userId: member.user_id, role: next },
      {
        onSuccess: () => {
          if (member.user_id === user.id) void invalidateMe();
          toast({ title: `${member.display_name || member.email} is now ${ROLE_LABELS[next].toLowerCase()}`, tone: 'success' });
        },
        onError: (error) => {
          toast({ title: 'Couldn’t change the role', description: errorMessage(error), tone: 'error' });
        },
      },
    );
  };

  const confirmRemoval = async (): Promise<void> => {
    if (!removal) return;
    try {
      await removeMember.mutateAsync(removal.member.user_id);
    } catch {
      return; // shown in the dialog
    }
    if (!removal.self) {
      toast({ title: `${removal.member.display_name || removal.member.email} removed`, tone: 'success' });
      setRemoval(null);
      return;
    }
    // Leaving: refresh /me, then move to another org (switchOrg goes to the overview).
    await invalidateMe();
    const next = orgs.find((item) => item.id !== orgId && item.personal) ?? orgs.find((item) => item.id !== orgId);
    toast({ title: `You left ${org.name}`, tone: 'success' });
    setRemoval(null);
    if (next) switchOrg(next.id);
  };

  const revoke = (inviteId: number, email: string): void => {
    deleteInvite.mutate(inviteId, {
      onSuccess: () => {
        toast({ title: `Invite for ${email} revoked`, tone: 'success' });
      },
      onError: (error) => {
        toast({ title: 'Couldn’t revoke the invite', description: errorMessage(error), tone: 'error' });
      },
    });
  };

  const list = members.data?.members ?? [];
  const invites = members.data?.invites ?? [];

  return (
    <div className="flex flex-col gap-4 border-t border-line pt-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 className="m-0 flex-1 text-[14px] font-semibold leading-5">
            Members {members.data && <span className="num text-ink-faint">{list.length}</span>}
          </h3>
          <Button
            size="sm"
            onClick={onInvite}
            disabled={!isAdmin}
            title={isAdmin ? undefined : 'Only admins can invite people'}
            leadingIcon={<UserPlusIcon className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />}
          >
            Invite
          </Button>
        </div>
        {members.isPending && (
          <div aria-busy="true" aria-label="Loading members" className="flex flex-col gap-2 rounded-lg border border-line p-3">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/5" />
          </div>
        )}
        {members.isError && <ErrorState variant="widget" error={members.error} onRetry={() => void members.refetch()} retrying={members.isFetching} />}
        {members.data && (
          <ul className="m-0 list-none rounded-lg border border-line p-0">
            {list.map((member) => {
              const perms = memberPermissions(viewer, member);
              const self = member.user_id === user.id;
              const name = member.display_name || member.email;
              return (
                <li key={member.user_id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2.5 last:border-b-0">
                  <span aria-hidden="true" className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-full bg-tint-accent text-[12px] font-semibold text-accent">
                    {initialsFor(name)}
                  </span>
                  <div className="flex min-w-[160px] flex-1 flex-col">
                    <span className="truncate text-[13px] font-medium">
                      {name}
                      {self && <span className="font-normal text-ink-faint"> (you)</span>}
                    </span>
                    <span className="num truncate text-[12px] leading-4 text-ink-faint">
                      {member.display_name ? `${member.email} · ` : ''}joined {formatRelativeTime(member.joined_at, now)}
                    </span>
                  </div>
                  {perms.canChangeRole ? (
                    <Select
                      size="sm"
                      hideLabel
                      label={`Role for ${name}`}
                      value={member.role}
                      options={ROLE_OPTIONS}
                      className="w-[118px]"
                      disabled={updateRole.isPending}
                      onChange={(next) => {
                        changeRole(member, next);
                      }}
                    />
                  ) : (
                    <RoleBadge role={member.role} />
                  )}
                  {(perms.canRemove || self) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="min-w-[68px]"
                      disabled={self && !perms.canLeave}
                      title={self && !perms.canLeave ? 'You can’t leave your personal organisation' : undefined}
                      onClick={() => {
                        removeMember.reset();
                        setRemoval({ member, self });
                      }}
                    >
                      {self ? 'Leave' : 'Remove'}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {invites.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="m-0 text-[14px] font-semibold leading-5">
            Pending invites <span className="num text-ink-faint">{invites.length}</span>
          </h3>
          <ul className="m-0 list-none rounded-lg border border-line p-0">
            {invites.map((invite) => (
              <li key={invite.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2.5 last:border-b-0">
                <div className="flex min-w-[160px] flex-1 flex-col">
                  <span className="num truncate text-[13px]">{invite.email}</span>
                  <span className="text-[12px] leading-4 text-ink-faint">{inviteExpiry(invite.expires_at, now)}</span>
                </div>
                <RoleBadge role={invite.role} />
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!isAdmin}
                  title={isAdmin ? undefined : 'Only admins can revoke invites'}
                  className="min-w-[68px]"
                  loading={deleteInvite.isPending && deleteInvite.variables === invite.id}
                  onClick={() => {
                    revoke(invite.id, invite.email);
                  }}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ConfirmDialog
        open={removal !== null}
        onClose={() => {
          setRemoval(null);
        }}
        onConfirm={confirmRemoval}
        title={removal?.self ? `Leave ${org.name}?` : `Remove ${removal?.member.display_name || removal?.member.email || 'member'}?`}
        description={
          removal?.self
            ? 'You lose access to its servers, rules and incidents. An admin can invite you back.'
            : `They lose access to ${org.name} immediately.`
        }
        confirmLabel={removal?.self ? 'Leave organisation' : 'Remove member'}
        pending={removeMember.isPending}
        error={removeMember.error ? errorMessage(removeMember.error) : undefined}
      />
    </div>
  );
}

// ---------------------------------------------------------------- plan

export function PlanSection() {
  const details = useOrgDetails();
  if (details.isPending) {
    return (
      <SettingsCard id="plan" title="Plan and usage">
        <div aria-busy="true" aria-label="Loading plan usage" className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-6 gap-y-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex flex-col gap-2">
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-1.5 w-full rounded-full" />
            </div>
          ))}
        </div>
      </SettingsCard>
    );
  }
  if (details.isError) {
    return (
      <SettingsCard id="plan" title="Plan and usage">
        <ErrorState variant="widget" error={details.error} onRetry={() => void details.refetch()} retrying={details.isFetching} />
      </SettingsCard>
    );
  }
  const { plan, usage } = details.data;
  return (
    <SettingsCard id="plan" title="Plan and usage" aside={<Chip>{plan.name} plan</Chip>} description={retentionText(plan)}>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-6 gap-y-4">
        <UsageMeter label="Servers" noun="servers" used={usage.servers} limit={plan.max_servers} />
        <UsageMeter label="Members" noun="members" used={usage.members} limit={plan.max_members} />
        <UsageMeter label="Alert rules" noun="alert rules" used={usage.rules} limit={plan.max_rules} />
        <UsageMeter label="Channels" noun="channels" used={usage.channels} limit={plan.max_channels} />
        <UsageMeter label="Alert emails today" noun="alert emails today" used={usage.alert_emails_today} limit={plan.alert_emails_per_day} />
      </div>
    </SettingsCard>
  );
}

// ---------------------------------------------------------------- status page

export function StatusPageSection() {
  const details = useOrgDetails();
  const servers = useServers();
  if (details.isPending || servers.isPending) {
    return (
      <SettingsCard title="Status page">
        <div aria-busy="true" aria-label="Loading status page settings" className="flex flex-col gap-3">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-2/3" />
        </div>
      </SettingsCard>
    );
  }
  if (details.isError || servers.isError) {
    const error = details.error ?? servers.error;
    return (
      <SettingsCard title="Status page">
        <ErrorState
          variant="widget"
          error={error}
          onRetry={() => {
            void details.refetch();
            void servers.refetch();
          }}
        />
      </SettingsCard>
    );
  }
  return <StatusPageEditor key={details.data.org.id} org={details.data.org} servers={servers.data.servers} />;
}

function StatusPageEditor({ org, servers }: { org: Org; servers: readonly ServerSummary[] }) {
  const { can } = useOrg();
  const { toast } = useToast();
  const update = useUpdateOrg();
  const slugId = useId();
  const serversLabelId = useId();
  const [saved, setSaved] = useState<StatusPageForm>(() => statusPageForm(org));
  const [form, setForm] = useState<StatusPageForm>(saved);
  const [attempted, setAttempted] = useState(false);
  const canEdit = can('admin');
  const dirty = statusPageDirty(saved, form);

  const conflict = hasErrorCode(update.error, 'conflict');
  const apiMessage = isApiError(update.error) && update.error.code === 'invalid' ? update.error.message : null;
  const slugProblem = (attempted ? slugError(form.slug) : undefined) ??
    (conflict ? 'That address is taken. Try another.' : apiMessage?.includes('address') ? apiMessage : undefined);
  const titleProblem = apiMessage?.includes('title') ? apiMessage : undefined;
  const generalError = update.error && !conflict && slugProblem === undefined && titleProblem === undefined ? errorMessage(update.error) : null;
  const publicUrl = statusPageUrl(window.location.origin, saved.slug);

  const set = (patch: Partial<StatusPageForm>): void => {
    setForm((current) => ({ ...current, ...patch }));
    if (update.error) update.reset();
  };

  const toggleServer = (id: number): void => {
    set({ serverIds: form.serverIds.includes(id) ? form.serverIds.filter((item) => item !== id) : [...form.serverIds, id] });
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setAttempted(true);
    if (!canEdit || !dirty || slugError(form.slug) !== undefined) return;
    update.mutate(statusPagePatch(saved, form), {
      onSuccess: ({ org: next }) => {
        const fresh = statusPageForm(next);
        setSaved(fresh);
        setForm(fresh);
        setAttempted(false);
        toast({ title: 'Status page saved', description: fresh.enabled ? 'It is public at its address.' : 'It is off.', tone: 'success' });
      },
    });
  };

  return (
    <SettingsCard title="Status page" description="A public page with 90-day uptime and recent incidents for the servers you pick.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <fieldset disabled={!canEdit} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0" title={canEdit ? undefined : ADMIN_ONLY}>
          <Toggle
            labelPosition="before"
            label="Public status page"
            description="Anyone with the link sees the picked servers’ names, uptime and incidents. No metrics or hosts are shown."
            checked={form.enabled}
            disabled={!canEdit}
            onChange={(enabled) => {
              set({ enabled });
            }}
          />
          <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4">
            <Input
              label="Title"
              size="lg"
              value={form.title}
              maxLength={MAX_STATUS_TITLE_LENGTH}
              placeholder={org.name}
              hint="Defaults to the organisation name."
              error={titleProblem}
              onChange={(event) => {
                set({ title: event.target.value });
              }}
            />
            <div className="flex flex-col gap-1.5">
              <label htmlFor={slugId} className={labelClasses}>
                Address
              </label>
              <div
                className={cn(
                  'flex h-10 min-w-0 items-center rounded border bg-bg pl-3 focus-within:border-accent focus-within:shadow-[0_0_0_3px_rgb(var(--ac-soft))]',
                  slugProblem ? 'border-crit' : 'border-line-strong',
                )}
              >
                <span className="num flex-none truncate text-[13px] text-ink-faint">{STATUS_PATH_PREFIX}</span>
                <input
                  id={slugId}
                  value={form.slug}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={slugProblem ? true : undefined}
                  aria-describedby={`${slugId}-hint`}
                  onChange={(event) => {
                    set({ slug: normalizeSlug(event.target.value) });
                  }}
                  className="num h-full min-w-0 flex-1 border-0 bg-transparent pr-3 text-[13px] text-ink outline-none focus-visible:outline-none"
                />
              </div>
              {slugProblem && (
                <span className="inline-flex items-center gap-1 text-[12px] leading-4 text-crit">
                  <StatusIcon status="critical" size={12} />
                  {slugProblem}
                </span>
              )}
              <span id={`${slugId}-hint`} className={hintClasses}>
                3 to 40 lowercase letters, numbers or dashes. The old address stops working when you change it.
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span id={serversLabelId} className={cn(labelClasses, 'flex-1')}>
                Servers on the page <span className="num font-normal text-ink-faint">{form.serverIds.length}</span>
              </span>
              {servers.length > 0 && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      set({ serverIds: servers.map((server) => server.id) });
                    }}
                  >
                    All
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      set({ serverIds: [] });
                    }}
                  >
                    None
                  </Button>
                </>
              )}
            </div>
            {servers.length === 0 ? (
              <span className={hintClasses}>Add a server first; it can then be shown here.</span>
            ) : (
              <div role="group" aria-labelledby={serversLabelId} className="flex flex-wrap gap-1.5">
                {servers.map((server) => (
                  <ChipButton
                    key={server.id}
                    pressed={form.serverIds.includes(server.id)}
                    className="num"
                    onClick={() => {
                      toggleServer(server.id);
                    }}
                  >
                    {server.name}
                  </ChipButton>
                ))}
              </div>
            )}
          </div>
        </fieldset>

        <CopyField
          label="Public URL"
          value={publicUrl}
          copyLabel="Copy status page URL"
          extra={
            <a
              href={publicUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClasses({ variant: 'ghost', size: 'sm' })}
              aria-label="Open the status page in a new tab"
            >
              <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
              Open
            </a>
          }
        />
        {!saved.enabled && <span className={cn(hintClasses, '-mt-2')}>The page is off, so the link shows “not found” until you turn it on and save.</span>}

        {generalError && (
          <div role="alert" className="rounded bg-tint-crit px-3 py-2.5 text-[13px] text-crit">
            {generalError}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {dirty && (
            <Button
              variant="ghost"
              onClick={() => {
                setForm(saved);
                setAttempted(false);
                update.reset();
              }}
            >
              Discard
            </Button>
          )}
          <Button type="submit" variant="primary" loading={update.isPending} disabled={!canEdit || !dirty} title={canEdit ? undefined : ADMIN_ONLY}>
            Save status page
          </Button>
        </div>
      </form>
    </SettingsCard>
  );
}
