import { Description, Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { ArrowPathIcon, KeyIcon } from '@heroicons/react/24/outline';
import { useState } from 'react';

import { errorMessage } from '../../api/errors';
import type { RotateTokenResponse, ServerDetailResponse, ServerSummary } from '../../api/types';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { CodeLine, CopyableCode } from '../../components/CopyableCode';
import { RelativeTime } from '../../components/RelativeTime';
import { getEnv } from '../../config/env';
import { useRotateServerToken } from '../../hooks/api/servers';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { useNow } from '../../hooks/useNow';
import { AGENT_CONFIG_PATH, AGENT_SERVICE_NAME } from '../../lib/agentInstall';
import { cn } from '../../lib/cn';
import { toTime } from '../../lib/format';

import { graceCountdown, maskedTokenPrefix, rotatedInstall } from './token';

const ADMIN_TOKEN_REASON = 'Only admins can rotate the agent token.';
const RESTART_COMMAND = `sudo systemctl restart ${AGENT_SERVICE_NAME}`;
const createdFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const createdWithYearFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** "Sep 12", with the year only when it is not this year. */
const formatCreated = (time: number): string =>
  (new Date(time).getFullYear() === new Date().getFullYear() ? createdFormat : createdWithYearFormat).format(time);

function GraceLine({ previousValidUntil }: { previousValidUntil: string }) {
  const now = useNow();
  const countdown = graceCountdown(previousValidUntil, now);
  if (!countdown) return null;
  return (
    <p role="status" className={cn('m-0 rounded px-3 py-2.5 text-[13px]', countdown.expired ? 'bg-tint-crit text-crit' : 'bg-tint-warn text-ink')}>
      {countdown.expired ? (
        <>The old token has stopped working. Agents still using it are rejected until their config has the new one.</>
      ) : (
        <>
          The old token stops working in <span className="num font-semibold">{countdown.remaining}</span> (at{' '}
          <span className="num">{countdown.at}</span>). Update the agent before then to keep data flowing.
        </>
      )}
    </p>
  );
}

function Rotated({ response, server }: { response: RotateTokenResponse; server: ServerSummary }) {
  const install = rotatedInstall(response, server, getEnv().agentEndpoint);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">New token</span>
        <CopyableCode code={install.token} copyLabel="Copy new token" />
        <span className="text-[12px] text-ink-faint">Shown once. Monitaur keeps only a hash, so copy it now.</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">
          Replace <span className="num">{install.configPath || AGENT_CONFIG_PATH}</span> with
        </span>
        <CopyableCode code={install.configText} block copyLabel="Copy new config" />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">Then restart the agent</span>
        <CodeLine>{RESTART_COMMAND}</CodeLine>
      </div>
      <GraceLine previousValidUntil={response.previous_valid_until} />
    </div>
  );
}

interface RotateDialogProps {
  open: boolean;
  onClose: () => void;
  server: ServerSummary;
}

/**
 * Rotate token: confirm, then show the new token once with the new config
 * and the time left on the old token (previous_valid_until).
 */
function RotateTokenDialog({ open, onClose, server }: RotateDialogProps) {
  const desktop = useIsDesktop();
  const rotate = useRotateServerToken();
  const result = rotate.data;

  const close = (): void => {
    if (rotate.isPending) return;
    onClose();
    rotate.reset();
  };

  return (
    <Dialog open={open} onClose={close} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-scrim" />
      <div className={cn('fixed inset-0 flex justify-center overflow-y-auto p-4', desktop ? 'items-center' : 'items-end')}>
        <DialogPanel className="flex w-full max-w-[560px] flex-col gap-4 rounded-xl border border-line-strong bg-surface-1 p-6 shadow-float">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-tint-crit text-crit">
              <KeyIcon className="h-5 w-5" strokeWidth={1.6} aria-hidden="true" />
            </span>
            <div className="flex flex-col gap-1">
              <DialogTitle className="m-0 text-[16px] font-semibold leading-6">
                {result ? 'New agent token' : `Rotate the token for ${server.name}?`}
              </DialogTitle>
              <Description className="m-0 text-[13px] text-ink-muted">
                {result
                  ? 'Put the new token on the server. Both tokens work until the old one expires.'
                  : 'A new token is issued now. The current one keeps working for 10 minutes so you can update the agent without a gap in data.'}
              </Description>
            </div>
          </div>

          {result && <Rotated response={result} server={server} />}

          {rotate.error && (
            <div role="alert" className="rounded bg-tint-crit px-3 py-2.5 text-[13px] text-crit">
              {errorMessage(rotate.error)}
            </div>
          )}

          <div className="flex justify-end gap-2">
            {result ? (
              <Button variant="primary" onClick={close}>
                Done
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={close} disabled={rotate.isPending}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  loading={rotate.isPending}
                  leadingIcon={<ArrowPathIcon className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />}
                  onClick={() => {
                    rotate.mutate(server.id);
                  }}
                >
                  Rotate token
                </Button>
              </>
            )}
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}

/** ServerSettings.dc.html "Agent token": the stored prefix, created / last used, and Rotate. */
export function TokenCard({ server, token, canRotate }: { server: ServerSummary; token: ServerDetailResponse['token']; canRotate: boolean }) {
  const [open, setOpen] = useState(false);
  const created = toTime(token.created_at);
  return (
    <Card as="section" aria-labelledby="token-heading" className="flex flex-col gap-3.5 p-5">
      <h2 id="token-heading" className="m-0 text-h3 font-semibold">
        Agent token
      </h2>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-bg px-3.5 py-3">
        <KeyIcon className="h-4 w-4 flex-none text-ink-faint" strokeWidth={1.8} aria-hidden="true" />
        <code className="num min-w-0 flex-1 break-all text-[13px]" aria-label={`Token starting ${token.prefix}`}>
          {maskedTokenPrefix(token.prefix)}
        </code>
        <span className="num text-[12px] text-ink-faint">
          created {created === null ? 'unknown' : formatCreated(created)} ·{' '}
          {token.last_used_at ? <RelativeTime value={token.last_used_at} prefix="used " /> : 'never used'}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <p className="m-0 flex-[1_1_260px] text-[13px] text-ink-muted">
          Rotating issues a new token. The old one keeps working for 10 minutes so you can update{' '}
          <span className="num">{AGENT_CONFIG_PATH}</span> without a gap in data.
        </p>
        <Button
          variant="danger-outline"
          disabled={!canRotate}
          title={canRotate ? undefined : ADMIN_TOKEN_REASON}
          onClick={() => {
            setOpen(true);
          }}
        >
          Rotate token
        </Button>
      </div>
      <RotateTokenDialog
        open={open}
        server={server}
        onClose={() => {
          setOpen(false);
        }}
      />
    </Card>
  );
}
