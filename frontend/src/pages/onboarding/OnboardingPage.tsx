import { ArrowRightIcon, KeyIcon } from '@heroicons/react/24/outline';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { errorMessage, hasErrorCode, isApiError } from '../../api/errors';
import type { CreateServerResponse, ServerSummary } from '../../api/types';
import { Button, ButtonLink } from '../../components/Button';
import { buttonClasses } from '../../components/buttonClasses';
import { Dino, type DinoBeatTone, type DinoMood } from '../../components/Dino';
import { CodeLine, CopyableCode } from '../../components/CopyableCode';
import { Input } from '../../components/Input';
import { LiveDot } from '../../components/LiveDot';
import { Logo } from '../../components/Logo';
import { Skeleton } from '../../components/Skeletons';
import { StatusBadge } from '../../components/StatusBadge';
import { TagInput } from '../../components/TagInput';
import { getEnv } from '../../config/env';
import { useCreateServer, useServer, useServers, useUpdateServer } from '../../hooks/api/servers';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { useNow } from '../../hooks/useNow';
import {
  AGENT_LOGS_COMMAND,
  AGENT_START_COMMAND,
  AGENT_STATUS_COMMAND,
  maskToken,
  resolveInstall,
  type ResolvedInstall,
} from '../../lib/agentInstall';
import { cn } from '../../lib/cn';
import { collectTags } from '../../lib/fleet';
import { formatElapsed, formatPercent } from '../../lib/format';
import { MAX_SERVER_NAME_LENGTH, normalizeServerName } from '../../lib/names';
import { SESSION_KEYS, writeStored } from '../../lib/storage';
import { useOrg } from '../../providers/OrgProvider';

/** Fallback poll while waiting for the first heartbeat (the SSE stream is primary). */
const CONNECT_POLL_MS = 5000;
const MS_PER_SECOND = 1000;

type Step = 1 | 2 | 3;

const STEPS: readonly { n: Step; label: string }[] = [
  { n: 1, label: 'Name it' },
  { n: 2, label: 'Install agent' },
  { n: 3, label: 'Connect' },
];

const isReporting = (server: ServerSummary | undefined): boolean => Boolean(server && (server.connected || server.latest !== null));

function Progress({ step, connected }: { step: Step; connected: boolean }) {
  return (
    <ol aria-label="Progress" className="m-0 grid list-none grid-cols-3 gap-2 p-0">
      {STEPS.map(({ n, label }) => {
        const done = n < step || (n === 3 && connected);
        const current = n === step && !done;
        return (
          <li key={n} aria-current={current ? 'step' : undefined} className="flex flex-col gap-2">
            <span className={cn('h-[3px] rounded-sm', done || current ? 'bg-accent' : 'bg-line-strong')} />
            <span className={cn('flex items-center gap-2 text-[13px] font-medium', done || current ? 'text-ink' : 'text-ink-faint')}>
              <span
                className={cn(
                  'num inline-flex h-5 w-5 items-center justify-center rounded-full border text-[11px]',
                  done ? 'border-accent bg-accent text-accent-ink' : current ? 'border-accent text-accent' : 'border-line-strong text-ink-faint',
                )}
              >
                {done ? '✓' : n}
              </span>
              {label}
              {done && <span className="sr-only"> (done)</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Renders config text with the token (or its mask) in the accent colour. */
function ConfigPreview({ text, token, revealed }: { text: string; token: string; revealed: boolean }) {
  const shown = revealed ? token : maskToken(token);
  const parts = text.split(token);
  const out: ReactNode[] = [];
  parts.forEach((part, index) => {
    out.push(<span key={`p${index}`}>{part}</span>);
    if (index < parts.length - 1) {
      out.push(
        <span key={`t${index}`} className="text-accent">
          {shown}
        </span>,
      );
    }
  });
  return <>{out}</>;
}

function StepLabel({ children }: { children: ReactNode }) {
  return <span className="text-[13px] font-medium text-ink">{children}</span>;
}

/**
 * Onboarding.dc.html and OnboardingMobile.dc.html: name the server, install
 * the agent with the real command and config, then wait for the first
 * heartbeat (live stream, with a 5 s poll as fallback).
 */
export default function OnboardingPage() {
  const desktop = useIsDesktop();
  const navigate = useNavigate();
  const { org, can } = useOrg();
  const now = useNow();
  const servers = useServers();
  const createServer = useCreateServer();
  const updateServer = useUpdateServer();

  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [created, setCreated] = useState<CreateServerResponse | null>(null);
  const [install, setInstall] = useState<ResolvedInstall | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [listeningSince, setListeningSince] = useState<number | null>(null);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);

  const serverId = created?.server.id ?? null;
  const fromList = servers.data?.servers.find((server) => server.id === serverId);
  const waiting = step === 3 && connectedAt === null;
  const detail = useServer(serverId, { refetchInterval: waiting ? CONNECT_POLL_MS : false });
  const current = detail.data?.server ?? fromList ?? created?.server;
  const reporting = isReporting(fromList) || isReporting(detail.data?.server);

  // Freeze the moment the first heartbeat is seen (derived during render).
  if (step === 3 && reporting && connectedAt === null) setConnectedAt(Date.now());

  const otherServers = (servers.data?.servers ?? []).filter((server) => server.id !== serverId);
  const firstServer = servers.data !== undefined && otherServers.length === 0;
  const canCreate = can('member');
  const trimmedName = name.replace(/^-+|-+$/g, '');
  const elapsedSeconds = listeningSince === null ? 0 : ((connectedAt ?? now) - listeningSince) / MS_PER_SECOND;
  const connected = step === 3 && connectedAt !== null;

  const mutationError = createServer.error ?? updateServer.error;
  const nameError = isApiError(mutationError) && (mutationError.code === 'invalid' || mutationError.code === 'conflict') ? mutationError.message : undefined;
  const limitReached = hasErrorCode(mutationError, 'limit_reached');

  const skip = (): void => {
    writeStored(SESSION_KEYS.onboardingDismissed, true, 'session');
    void navigate('/');
  };

  const submitName = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (trimmedName === '' || !canCreate) return;
    if (created) {
      const unchanged = created.server.name === trimmedName && created.server.tags.join() === tags.join();
      if (unchanged) {
        setStep(2);
        return;
      }
      updateServer.mutate(
        { serverId: created.server.id, body: { name: trimmedName, tags } },
        {
          onSuccess: ({ server }) => {
            const next = { ...created, server };
            setCreated(next);
            setInstall(resolveInstall(next, getEnv().agentEndpoint));
            setStep(2);
          },
        },
      );
      return;
    }
    createServer.mutate(
      { name: trimmedName, tags },
      {
        onSuccess: (response) => {
          setCreated(response);
          setInstall(resolveInstall(response, getEnv().agentEndpoint));
          setStep(2);
        },
      },
    );
  };

  const startListening = (): void => {
    setStep(3);
    setListeningSince(Date.now());
    setConnectedAt(null);
  };

  const addAnother = (): void => {
    setStep(1);
    setName('');
    setTags([]);
    setCreated(null);
    setInstall(null);
    setRevealed(false);
    setListeningSince(null);
    setConnectedAt(null);
    createServer.reset();
    updateServer.reset();
  };

  const look: { mood: DinoMood; beat: DinoBeatTone; quip: string } =
    step === 1
      ? { mood: 'default', beat: 'accent', quip: 'Rex keeps an eye on your boxes so you don’t have to.' }
      : step === 2
        ? { mood: 'default', beat: 'accent', quip: 'Paste, run, and Rex starts listening.' }
        : connected
          ? { mood: 'happy', beat: 'ok', quip: 'Heartbeat received. Rex approves.' }
          : { mood: 'waiting', beat: 'muted', quip: 'Listening for the first heartbeat…' };

  const displayName = created?.server.name ?? (trimmedName || 'your server');
  const agentHost = (() => {
    try {
      return new URL(getEnv().serverWsUrl).host;
    } catch {
      return getEnv().serverWsUrl;
    }
  })();

  return (
    <div className="flex min-h-screen flex-col bg-bg text-[14px] text-ink">
      <header className={cn('flex h-16 items-center gap-3 border-b border-line', desktop ? 'px-8' : 'px-4')}>
        <Link to="/" className="text-ink no-underline hover:text-ink" aria-label="Monitaur overview">
          <Logo size={28} />
        </Link>
        <span className="flex-1" />
        {firstServer && !created ? (
          <Button variant="ghost" size="sm" onClick={skip}>
            Skip for now
          </Button>
        ) : (
          <Link to="/" className={buttonClasses({ variant: 'ghost', size: 'sm' })}>
            Back to overview
          </Link>
        )}
      </header>

      <main className={cn('mx-auto box-border flex w-full max-w-[1040px] flex-1 flex-wrap content-start items-start gap-12', desktop ? 'px-8 py-14' : 'px-4 pb-8 pt-6')}>
        <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-7">
          <div className="flex flex-col gap-1.5">
            <span className="cap">{firstServer ? 'No servers yet' : org.name}</span>
            <h1 className={cn('m-0 font-semibold leading-tight tracking-[-0.01em]', desktop ? 'text-[32px]' : 'text-[24px]')}>
              {firstServer ? 'Add your first server' : 'Add a server'}
            </h1>
            <p className="m-0 text-ink-muted">
              Three steps, about a minute. The agent is a small Go binary that only opens an outbound connection to Monitaur.
            </p>
          </div>

          <Progress step={step} connected={connected} />

          {step === 1 && (
            <form onSubmit={submitName} className="flex flex-col gap-[18px] rounded-lg border border-line bg-surface-1 p-6">
              <Input
                label="Server name"
                size="xl"
                className="num text-[15px]"
                value={name}
                placeholder="web-01"
                autoComplete="off"
                spellCheck={false}
                required
                maxLength={MAX_SERVER_NAME_LENGTH}
                // The single field of this step; focusing it saves a click.
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                onChange={(event) => {
                  setName(normalizeServerName(event.target.value));
                }}
                hint="Lowercase letters, numbers and dashes. You can rename later."
                error={nameError}
              />
              <TagInput
                label={
                  <>
                    Tags <span className="font-normal text-ink-faint">(optional)</span>
                  </>
                }
                value={tags}
                onChange={setTags}
                suggestions={collectTags(otherServers)}
              />
              {limitReached && (
                <div role="alert" className="rounded bg-tint-warn px-3 py-2.5 text-[13px] text-warn">
                  Your plan’s server limit is reached. Remove a server or upgrade the plan to add another.
                </div>
              )}
              {mutationError && !nameError && !limitReached && (
                <div role="alert" className="rounded bg-tint-crit px-3 py-2.5 text-[13px] text-crit">
                  {errorMessage(mutationError)}
                </div>
              )}
              <div className="flex justify-end">
                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  loading={createServer.isPending || updateServer.isPending}
                  disabled={trimmedName === '' || !canCreate}
                  title={canCreate ? undefined : 'Viewers can’t add servers'}
                >
                  {created ? 'Save & continue' : 'Create server & token'}
                </Button>
              </div>
            </form>
          )}

          {step === 2 && install && (
            <section aria-label="Install the agent" className="flex flex-col gap-[18px] rounded-lg border border-line bg-surface-1 p-6">
              <div className="flex flex-col gap-2">
                <StepLabel>
                  1 · Run on <span className="num">{displayName}</span> as root
                </StepLabel>
                <CopyableCode code={install.command} prompt copyLabel="Copy install command" />
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <StepLabel>
                    2 · Paste into <span className="num">{install.configPath}</span>
                  </StepLabel>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-pressed={revealed}
                    onClick={() => {
                      setRevealed(!revealed);
                    }}
                  >
                    {revealed ? 'Hide token' : 'Reveal token'}
                  </Button>
                </div>
                <CopyableCode code={install.configText} block copyLabel="Copy config">
                  <ConfigPreview text={install.configText} token={install.token} revealed={revealed} />
                </CopyableCode>
                <div className="flex items-start gap-2 text-[12px] text-ink-muted">
                  <KeyIcon className="mt-px h-3.5 w-3.5 flex-none text-warn" strokeWidth={1.8} aria-hidden="true" />
                  <span>The token is shown once. Treat it like a password; you can rotate it any time in server settings.</span>
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <StepLabel>3 · Start it</StepLabel>
                <CodeLine>{AGENT_START_COMMAND}</CodeLine>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setStep(1);
                  }}
                >
                  Back
                </Button>
                <Button variant="primary" size="lg" onClick={startListening}>
                  I’ve started the agent
                </Button>
              </div>
            </section>
          )}

          {step === 3 && (
            <section
              aria-live="polite"
              aria-label="Agent connection"
              className={cn('flex flex-col gap-[18px] rounded-lg border bg-surface-1 p-6', connected ? 'border-ok' : 'border-line')}
            >
              {!connected ? (
                <>
                  <div className="flex items-center gap-3.5">
                    <LiveDot size={14} tone="accent" />
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[16px] font-semibold">
                        Waiting for <span className="num">{displayName}</span> to connect…
                      </span>
                      <span className="num text-[12px] text-ink-faint">listening for {formatElapsed(elapsedSeconds)}</span>
                    </div>
                  </div>
                  <ul className="m-0 flex list-none flex-col gap-2.5 p-0 text-[13px]">
                    <li className="flex items-center gap-2.5">
                      <StatusBadge status="healthy" variant="icon" />
                      Server and token created
                    </li>
                    <li className="flex items-center gap-2.5">
                      <StatusBadge status="healthy" variant="icon" />
                      Install command and config ready
                    </li>
                    <li className="flex items-center gap-2.5 text-ink-muted">
                      <Skeleton round className="h-3.5 w-3.5" />
                      First heartbeat from the agent
                    </li>
                  </ul>
                  <details className="border-t border-line pt-3.5 text-[13px] text-ink-muted">
                    <summary className="cursor-pointer font-medium text-ink">Not connecting after a minute?</summary>
                    <ul className="m-0 mt-2.5 flex flex-col gap-1.5 pl-[18px]">
                      <li>
                        Check the server can open an outbound connection to <span className="num">{agentHost}</span>.
                      </li>
                      <li>
                        Run <span className="num">{AGENT_LOGS_COMMAND}</span> and look for “401” (wrong token).
                      </li>
                      <li>
                        Make sure the service is running: <span className="num">{AGENT_STATUS_COMMAND}</span>.
                      </li>
                    </ul>
                  </details>
                  <div className="flex justify-between">
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setStep(2);
                      }}
                    >
                      Back to install steps
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-3">
                    <StatusBadge status="healthy" text="Connected" />
                    <span className="text-[16px] font-semibold">
                      <span className="num">{displayName}</span> is reporting
                    </span>
                    <span className="num text-[12px] text-ink-faint">first metric after {formatElapsed(elapsedSeconds)}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    {(
                      [
                        ['CPU', current?.latest?.cpu],
                        ['Memory', current?.latest?.mem],
                        ['Disk', current?.latest?.disk],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label} className="flex flex-col gap-1 rounded-lg bg-surface-2 p-3">
                        <span className="cap">{label}</span>
                        <span className="num text-[22px] font-medium">{formatPercent(value ?? null)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-wrap justify-between gap-3">
                    <Button onClick={addAnother}>Add another server</Button>
                    <ButtonLink
                      to="/"
                      variant="primary"
                      size="lg"
                      trailingIcon={<ArrowRightIcon className="h-4 w-4" strokeWidth={2} aria-hidden="true" />}
                    >
                      Open dashboard
                    </ButtonLink>
                  </div>
                </>
              )}
            </section>
          )}
        </div>

        <aside
          aria-hidden="true"
          className={cn('flex flex-[1_1_280px] flex-col items-center gap-4', desktop ? 'order-none pt-[72px]' : '-order-1 pt-0')}
        >
          <Dino mood={look.mood} size={desktop ? 260 : 140} beatTone={look.beat} label="" />
          <p className="m-0 max-w-[260px] text-center text-[13px] text-ink-muted">{look.quip}</p>
        </aside>
      </main>
    </div>
  );
}
