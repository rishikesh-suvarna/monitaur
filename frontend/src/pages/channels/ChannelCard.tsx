import { CheckIcon, PaperAirplaneIcon } from '@heroicons/react/24/outline';
import { useEffect, useId, useState } from 'react';

import { isApiError } from '../../api/errors';
import type { Channel, ChannelType } from '../../api/types';
import { Button } from '../../components/Button';
import { cardClasses } from '../../components/Card';
import { StatusIcon } from '../../components/StatusBadge';
import { statusTextClass } from '../../components/statusClasses';
import { useToast } from '../../components/toastContext';
import { Toggle } from '../../components/Toggle';
import { useTestChannel, useUpdateChannel } from '../../hooks/api/channels';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { useNow } from '../../hooks/useNow';
import { CHANNEL_TYPE_LABELS, channelLabel } from '../../lib/channels';
import { cn } from '../../lib/cn';

import { CHANNEL_PITCH, channelStatus, deliveryText, summaryLines, testOutcome, type TestOutcome } from './channelModel';
import { ChannelTypeTile } from './ChannelTypeIcon';

/** "Sent" / "Failed" flips back to "Send test" after this long. */
const TEST_LABEL_RESET_MS = 4000;

export const ADMIN_ONLY = 'Only admins can change channels';

export interface ChannelCardProps {
  channel: Channel;
  canManage: boolean;
  canTest: boolean;
  onEdit: () => void;
}

/** Channels.dc.html card for a connected channel. */
export function ChannelCard({ channel, canManage, canTest, onEdit }: ChannelCardProps) {
  const headingId = useId();
  const desktop = useIsDesktop();
  const now = useNow();
  const { toast } = useToast();
  const test = useTestChannel();
  const toggle = useUpdateChannel();
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  const [flash, setFlash] = useState<'sent' | 'failed' | null>(null);

  useEffect(() => {
    if (flash === null) return;
    const timer = setTimeout(() => {
      setFlash(null);
    }, TEST_LABEL_RESET_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [flash]);

  const label = channelLabel(channel);
  const sending = test.isPending;
  const rateLimited = isApiError(test.error) && test.error.code === 'rate_limited';

  const sendTest = (): void => {
    setOutcome(null);
    test
      .mutateAsync(channel.id)
      .then((result) => {
        const next = testOutcome(result, null);
        setOutcome(next);
        setFlash(next.ok ? 'sent' : 'failed');
      })
      .catch((error: unknown) => {
        setOutcome(testOutcome(undefined, error));
        // A 429 is not a delivery failure; the note says to wait.
        setFlash(isApiError(error) && error.code === 'rate_limited' ? null : 'failed');
      });
  };

  const setEnabled = (enabled: boolean): void => {
    toggle.mutate(
      { channelId: channel.id, body: { enabled } },
      {
        onError: (error) => {
          toast({ title: `Couldn’t ${enabled ? 'enable' : 'disable'} ${label}`, description: error.message, tone: 'error' });
        },
      },
    );
  };

  // Optimistic: show the switch where the user put it while the PATCH runs.
  const enabled = toggle.isPending && toggle.variables.body.enabled !== undefined ? toggle.variables.body.enabled : channel.enabled;
  // A test that just went through clears the failing state before the refetch lands.
  const view = channelStatus({ enabled, last_delivery_ok: outcome?.ok === true ? true : channel.last_delivery_ok });
  const failing = view.failing;
  const note = outcome && !outcome.ok ? outcome.message : failing && channel.last_error ? `Last delivery failed: ${channel.last_error}` : null;
  const noteTone = rateLimited ? 'text-ink-muted' : 'text-warn';
  const testLabel = sending ? 'Sending…' : flash === 'sent' ? 'Sent' : flash === 'failed' ? 'Failed' : 'Send test';
  const last = outcome?.ok ? 'delivered just now' : deliveryText(channel, now);
  const buttonSize = desktop ? 'sm' : 'touch';

  return (
    <article aria-labelledby={headingId} className={cn(cardClasses, 'flex flex-col gap-3.5 p-[18px]', failing && 'border-warn')}>
      <div className="flex items-start gap-3">
        <ChannelTypeTile type={channel.type} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 id={headingId} className="m-0 truncate text-[15px] font-semibold leading-[22px]" title={label}>
            {label}
          </h2>
          <span
            className={cn(
              'inline-flex items-center gap-1.5 text-[12px] leading-4',
              failing ? 'text-warn' : enabled ? 'text-ink-muted' : 'text-ink-faint',
            )}
          >
            <StatusIcon status={view.status} size={12} className={statusTextClass(view.status)} />
            {view.label}
          </span>
        </div>
        <div title={canManage ? undefined : ADMIN_ONLY}>
          <Toggle hideLabel label={`${enabled ? 'Disable' : 'Enable'} ${label}`} checked={enabled} onChange={setEnabled} disabled={!canManage} />
        </div>
      </div>

      <div
        className={cn(
          'num min-h-9 whitespace-pre-line break-all rounded border border-line bg-bg px-3 py-2.5 text-[12px] leading-[18px] text-ink-muted',
          !enabled && 'opacity-60',
        )}
      >
        {summaryLines(channel).join('\n')}
      </div>

      {note && (
        <p role={outcome ? 'status' : undefined} className={cn('m-0 break-words text-[12px] leading-4', noteTone)}>
          {note}
        </p>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-2">
        <Button
          size={buttonSize}
          onClick={sendTest}
          loading={sending}
          disabled={!canTest}
          title={canTest ? undefined : 'Viewers can’t send test messages'}
          leadingIcon={
            flash === 'sent' ? (
              <CheckIcon className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
            ) : (
              <PaperAirplaneIcon className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
            )
          }
        >
          {testLabel}
        </Button>
        <Button size={buttonSize} variant="ghost" onClick={onEdit} disabled={!canManage} title={canManage ? undefined : ADMIN_ONLY}>
          Edit
        </Button>
        <span className="flex-1" />
        <span className="num text-[12px] leading-4 text-ink-faint" aria-live="polite">
          {last}
        </span>
      </div>
    </article>
  );
}

export interface ConnectCardProps {
  type: ChannelType;
  canManage: boolean;
  onConnect: () => void;
}

/** A type with no channel yet: "Not connected" and "Connect <type>". */
export function ConnectCard({ type, canManage, onConnect }: ConnectCardProps) {
  const headingId = useId();
  const desktop = useIsDesktop();
  const label = CHANNEL_TYPE_LABELS[type];
  return (
    <article aria-labelledby={headingId} className={cn(cardClasses, 'flex flex-col gap-3.5 p-[18px]')}>
      <div className="flex items-start gap-3">
        <ChannelTypeTile type={type} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 id={headingId} className="m-0 text-[15px] font-semibold leading-[22px]">
            {label}
          </h2>
          <span className="inline-flex items-center gap-1.5 text-[12px] leading-4 text-ink-faint">
            <StatusIcon status="offline" size={12} className="text-off" />
            Not connected
          </span>
        </div>
      </div>
      <div className="num min-h-9 rounded border border-line bg-bg px-3 py-2.5 text-[12px] leading-[18px] text-ink-muted opacity-60">Not connected</div>
      <p className="m-0 text-[12px] leading-4 text-ink-muted">{CHANNEL_PITCH[type]}</p>
      <div className="mt-auto flex flex-wrap items-center gap-2">
        <Button variant="primary" size={desktop ? 'sm' : 'touch'} onClick={onConnect} disabled={!canManage} title={canManage ? undefined : ADMIN_ONLY}>
          Connect {label}
        </Button>
      </div>
    </article>
  );
}
