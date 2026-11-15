import { Radio, RadioGroup } from '@headlessui/react';
import { ArrowLeftStartOnRectangleIcon } from '@heroicons/react/24/outline';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';

import { errorMessage } from '../../api/errors';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Input } from '../../components/Input';
import { hintClasses } from '../../components/inputClasses';
import { StatusBadge } from '../../components/StatusBadge';
import { useToast } from '../../components/toastContext';
import { Toggle } from '../../components/Toggle';
import { useDeleteAccount, useRevokeSessions, useUpdateMe } from '../../hooks/api/me';
import { useExportData } from '../../hooks/api/org';
import { getEnv } from '../../config/env';
import { cn } from '../../lib/cn';
import { initialsFor } from '../../lib/names';
import { useAuth } from '../../providers/AuthProvider';
import { useMotion } from '../../providers/MotionProvider';
import { useOrg } from '../../providers/OrgProvider';
import { useTheme, type ThemePreference } from '../../providers/ThemeProvider';

import { CopyField, InlineSave, SettingsCard } from './SettingsCard';
import { emailHint, MAX_DISPLAY_NAME_LENGTH, providerName } from './settingsModel';

// ---------------------------------------------------------------- profile

export function ProfileSection() {
  const { user } = useOrg();
  const { toast } = useToast();
  const update = useUpdateMe();
  const [name, setName] = useState(user.display_name);
  const shown = user.display_name || user.email;
  const dirty = name.trim() !== user.display_name;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!dirty) return;
    update.mutate(
      { display_name: name.trim() },
      {
        onSuccess: ({ user: saved }) => {
          setName(saved.display_name);
          toast({ title: 'Display name saved', tone: 'success' });
        },
      },
    );
  };

  return (
    <SettingsCard title="Profile">
      <div className="flex flex-wrap items-center gap-3.5">
        <span aria-hidden="true" className="inline-flex h-12 w-12 flex-none items-center justify-center rounded-full bg-tint-accent font-semibold text-accent">
          {initialsFor(shown)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-semibold">{shown}</span>
          <span className="text-[13px] text-ink-muted">Signed in with {providerName(user.provider)}</span>
        </div>
      </div>
      <form onSubmit={submit} className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
        <Input
          label="Display name"
          size="lg"
          value={name}
          maxLength={MAX_DISPLAY_NAME_LENGTH}
          autoComplete="name"
          placeholder={user.email}
          error={update.error ? errorMessage(update.error) : undefined}
          className={cn(dirty && 'pr-[72px]')}
          onChange={(event) => {
            setName(event.target.value);
            if (update.error) update.reset();
          }}
          trailing={dirty ? <InlineSave visible pending={update.isPending} /> : undefined}
        />
        <Input label="Email" size="lg" value={user.email} readOnly className="!text-ink-muted" hint={emailHint(user.provider)} />
      </form>
    </SettingsCard>
  );
}

// ---------------------------------------------------------------- appearance

interface ThemeChoice {
  value: ThemePreference;
  label: string;
}

const THEME_CHOICES: readonly ThemeChoice[] = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

/** A tiny dashboard drawn with the real tokens of that theme (scoped data-theme). */
function ThemePreview({ value }: { value: ThemePreference }) {
  const pane = (theme: 'dark' | 'light', className: string) => (
    <span data-theme={theme} className={cn('flex flex-col gap-1 bg-bg p-2', className)}>
      <span className="h-1.5 w-3/5 rounded-[2px] bg-line-strong" />
      <span className="h-1.5 w-2/5 rounded-[2px] bg-line-strong" />
      <span className="h-1.5 w-3.5 rounded-[2px] bg-ok" />
    </span>
  );
  return (
    <span aria-hidden="true" className="flex h-16 overflow-hidden rounded border border-line">
      {value === 'system' ? (
        <>
          {pane('dark', 'flex-1')}
          {pane('light', 'flex-[0.6]')}
        </>
      ) : (
        pane(value, 'flex-1')
      )}
    </span>
  );
}

export function AppearanceSection() {
  const { preference, setPreference } = useTheme();
  const { reduced, systemReduced, override, setOverride } = useMotion();
  return (
    <SettingsCard title="Appearance">
      <RadioGroup value={preference} onChange={setPreference} aria-label="Theme" className="grid grid-cols-3 gap-3">
        {THEME_CHOICES.map((choice) => (
          <Radio
            key={choice.value}
            value={choice.value}
            className={cn(
              'flex cursor-pointer flex-col gap-2 rounded-lg border border-line bg-surface-1 p-2 text-left text-[13px] font-medium text-ink',
              'data-[checked]:border-accent data-[checked]:shadow-[0_0_0_1px_rgb(var(--ac))]',
              'focus:outline-none data-[focus]:outline data-[focus]:outline-2 data-[focus]:outline-offset-2 data-[focus]:outline-accent',
            )}
          >
            <ThemePreview value={choice.value} />
            {choice.label}
          </Radio>
        ))}
      </RadioGroup>
      <div className="border-t border-line pt-3.5">
        <Toggle
          labelPosition="before"
          label="Reduce motion"
          description={
            <>
              Stops number ticks and sparkline sliding. Follows your OS setting by default
              {override === null ? ` (currently ${systemReduced ? 'on' : 'off'}).` : '; you have overridden it here.'}
            </>
          }
          checked={reduced}
          onChange={(next) => {
            // Matching the OS again drops the override, so later OS changes apply.
            setOverride(next === systemReduced ? null : next);
          }}
        />
        {override !== null && (
          <Button
            size="sm"
            variant="ghost"
            className="mt-1 -ml-2.5"
            onClick={() => {
              setOverride(null);
            }}
          >
            Follow my OS setting
          </Button>
        )}
      </div>
    </SettingsCard>
  );
}

// ---------------------------------------------------------------- API endpoint

const HEALTH_PATH = '/health';
const HEALTH_TIMEOUT_MS = 5000;
const HEALTH_STALE_MS = 30_000;

interface Health {
  ms: number;
}

/** GET /health (no auth, no DB) timed from the browser. */
async function checkHealth(serverUrl: string, signal: AbortSignal): Promise<Health> {
  // Same approach as the API client: no AbortSignal.any, for older Safari.
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  const timer = setTimeout(abort, HEALTH_TIMEOUT_MS);
  signal.addEventListener('abort', abort, { once: true });
  const started = performance.now();
  try {
    const response = await fetch(`${serverUrl}${HEALTH_PATH}`, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { ms: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

export function ApiEndpointSection() {
  const env = getEnv();
  const health = useQuery({
    queryKey: ['public', 'health', env.serverUrl],
    queryFn: ({ signal }) => checkHealth(env.serverUrl, signal),
    staleTime: HEALTH_STALE_MS,
    retry: false,
  });
  const badge = health.isPending ? (
    <span className="text-[12px] text-ink-faint">Checking…</span>
  ) : health.isError ? (
    <StatusBadge status="critical" size="sm" text="Unreachable" />
  ) : (
    <StatusBadge status="healthy" size="sm" text={`Reachable · ${health.data.ms} ms`} />
  );
  return (
    <SettingsCard title="API endpoint" aside={badge} className="gap-3.5">
      <CopyField label="API URL" value={env.apiBaseUrl} copyLabel="Copy API URL" />
      <CopyField label="Agent ingest" value={env.agentEndpoint} copyLabel="Copy ingest URL" />
      <span className={hintClasses}>Agents report to the ingest URL; the dashboard reads from the API URL.</span>
    </SettingsCard>
  );
}

// ---------------------------------------------------------------- session

export function SessionSection() {
  const { signOut } = useAuth();
  const { toast } = useToast();
  const revoke = useRevokeSessions();
  const signOutEverywhere = (): void => {
    revoke.mutate(undefined, {
      onSuccess: () => {
        void signOut();
      },
      onError: (error) => {
        toast({ title: 'Couldn’t sign out other devices', description: errorMessage(error), tone: 'error' });
      },
    });
  };
  return (
    <section aria-labelledby="session-heading" className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-1 p-5">
      <div className="flex min-w-0 flex-[1_1_240px] flex-col gap-0.5">
        <h2 id="session-heading" className="m-0 text-[16px] font-semibold leading-6">
          Session
        </h2>
        <span className={hintClasses}>Signed in on this browser. Signing out everywhere also ends sessions on your other devices.</span>
      </div>
      <Button onClick={signOutEverywhere} loading={revoke.isPending}>
        Sign out everywhere
      </Button>
      <Button
        onClick={() => void signOut()}
        leadingIcon={<ArrowLeftStartOnRectangleIcon className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />}
      >
        Sign out
      </Button>
    </section>
  );
}

// ---------------------------------------------------------------- danger zone

export function DangerZone() {
  const { user, org, can } = useOrg();
  const { signOut } = useAuth();
  const { toast } = useToast();
  const exportData = useExportData();
  const deleteAccount = useDeleteAccount();
  const [confirming, setConfirming] = useState(false);
  const canExport = can('admin');

  const runExport = (): void => {
    exportData.mutate(undefined, {
      onSuccess: () => {
        toast({ title: 'Export downloaded', description: `${org.name} as JSON.`, tone: 'success' });
      },
      onError: (error) => {
        toast({ title: 'Export failed', description: errorMessage(error), tone: 'error' });
      },
    });
  };

  const remove = async (): Promise<void> => {
    try {
      await deleteAccount.mutateAsync();
    } catch {
      return; // shown in the dialog
    }
    await signOut();
  };

  return (
    <section aria-labelledby="danger-heading" className="flex flex-col gap-3.5 rounded-lg border border-crit p-5">
      <h2 id="danger-heading" className="m-0 text-[16px] font-semibold leading-6 text-crit">
        Danger zone
      </h2>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-0.5">
          <span className="font-medium">Export all data</span>
          <span className="text-[13px] text-ink-muted">
            {org.name}’s servers, rules, channels (secrets redacted), 90 days of incidents and 30 days of hourly metrics as JSON.
          </span>
        </div>
        <Button onClick={runExport} loading={exportData.isPending} disabled={!canExport} title={canExport ? undefined : 'Only admins can export data'}>
          Export
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3.5">
        <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-0.5">
          <span className="font-medium">Delete account</span>
          <span className="text-[13px] text-ink-muted">
            Deletes your account and every organisation you are the only owner of, with all their servers and history. Agents stop being accepted
            immediately.
          </span>
        </div>
        <Button
          variant="danger"
          onClick={() => {
            deleteAccount.reset();
            setConfirming(true);
          }}
        >
          Delete account…
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
        }}
        onConfirm={remove}
        title="Delete your account?"
        description="This cannot be undone. Organisations you share with other owners stay; you are removed from them."
        confirmLabel="Delete account"
        confirmText={user.email}
        confirmTextNoun="Email"
        pending={deleteAccount.isPending}
        error={deleteAccount.error ? errorMessage(deleteAccount.error) : undefined}
      />
    </section>
  );
}
