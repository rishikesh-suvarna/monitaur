import { Description, Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { useState, type FormEvent, type ReactNode } from 'react';

import { errorMessage, hasErrorCode, isApiError } from '../../api/errors';
import type { Channel, ChannelType } from '../../api/types';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Input } from '../../components/Input';
import { LimitReachedHint } from '../../components/LimitReachedHint';
import { useToast } from '../../components/toastContext';
import { useCreateChannel, useDeleteChannel, useUpdateChannel } from '../../hooks/api/channels';
import { useOrgDetails } from '../../hooks/api/org';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { CHANNEL_TYPE_LABELS, channelLabel } from '../../lib/channels';
import { cn } from '../../lib/cn';
import { usageState } from '../../lib/usage';

import {
  buildCreateBody,
  buildUpdateBody,
  CHANNEL_PITCH,
  emptyChannelForm,
  fieldForChannelError,
  MAX_CHANNEL_NAME_LENGTH,
  MAX_WEBHOOK_SECRET_LENGTH,
  parseRecipients,
  validateChannelForm,
  type ChannelForm,
  type ChannelFormErrors,
  type ChannelFormMode,
} from './channelModel';
import { ChannelTypeTile } from './ChannelTypeIcon';
import { EmailListInput } from './EmailListInput';
import { SignatureNote } from './SignatureNote';

export interface ChannelDialogProps {
  type: ChannelType;
  /** Present when editing. */
  channel: Channel | null;
  onClose: () => void;
}

/**
 * "Connect <type>" and edit forms. Existing secrets are never shown: edit
 * starts with empty secret fields and leaving them empty keeps the stored
 * config (no `config` in the PATCH).
 */
export function ChannelDialog({ type, channel, onClose }: ChannelDialogProps) {
  const desktop = useIsDesktop();
  const { toast } = useToast();
  const org = useOrgDetails();
  const create = useCreateChannel();
  const update = useUpdateChannel();
  const remove = useDeleteChannel();
  const [form, setForm] = useState<ChannelForm>(() => emptyChannelForm(type, channel ?? undefined));
  const [recipientDraft, setRecipientDraft] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const mode: ChannelFormMode = channel ? { kind: 'edit', channel } : { kind: 'create' };
  const editing = channel !== null;
  const typeLabel = CHANNEL_TYPE_LABELS[type];
  const withDraft: ChannelForm = recipientDraft.trim() === '' ? form : { ...form, recipients: [...form.recipients, ...parseRecipients(recipientDraft, form.recipients)] };
  const clientErrors = attempted ? validateChannelForm(type, withDraft, mode) : {};

  const mutation = editing ? update : create;
  const limitReached = hasErrorCode(mutation.error, 'limit_reached');
  const apiMessage = isApiError(mutation.error) && mutation.error.code === 'invalid' ? mutation.error.message : null;
  const apiField = apiMessage === null ? null : fieldForChannelError(apiMessage);
  const errors: ChannelFormErrors = apiField && apiMessage ? { ...clientErrors, [apiField]: apiMessage } : clientErrors;
  const generalError = mutation.error && !limitReached && apiField === null ? errorMessage(mutation.error) : null;

  const plan = org.data?.plan;
  const usage = org.data?.usage;
  const atLimit = !editing && plan !== undefined && usage !== undefined && usageState(usage.channels, plan.max_channels).atLimit;

  const set = (patch: Partial<ChannelForm>): void => {
    setForm((current) => ({ ...current, ...patch }));
    if (mutation.error) mutation.reset();
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setAttempted(true);
    setForm(withDraft);
    setRecipientDraft('');
    if (Object.keys(validateChannelForm(type, withDraft, mode)).length > 0) return;
    if (channel) {
      const body = buildUpdateBody(channel, withDraft);
      if (Object.keys(body).length === 0) {
        onClose();
        return;
      }
      update.mutate(
        { channelId: channel.id, body },
        {
          onSuccess: ({ channel: saved }) => {
            toast({ title: `${channelLabel(saved)} saved`, tone: 'success' });
            onClose();
          },
        },
      );
      return;
    }
    create.mutate(buildCreateBody(type, withDraft), {
      onSuccess: ({ channel: created }) => {
        toast({ title: `${channelLabel(created)} connected`, description: 'Send a test to check the delivery.', tone: 'success' });
        onClose();
      },
    });
  };

  const confirmRemove = (): void => {
    if (!channel) return;
    remove.mutate(channel.id, {
      onSuccess: () => {
        toast({ title: `${channelLabel(channel)} deleted`, tone: 'success' });
        setConfirmDelete(false);
        onClose();
      },
    });
  };

  const keepHint = (current: string | undefined, what: string): string =>
    `Currently ${current ?? 'set'}. Leave empty to keep the stored ${what}.`;
  const summary = channel?.summary ?? {};
  const pending = create.isPending || update.isPending;

  return (
    <Dialog open onClose={pending ? () => undefined : onClose} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-scrim" />
      <div className={cn('fixed inset-0 flex justify-center overflow-y-auto p-4', desktop ? 'items-center' : 'items-end')}>
        <DialogPanel
          as="form"
          noValidate
          onSubmit={submit}
          className="flex w-full max-w-[520px] flex-col gap-4 rounded-xl border border-line-strong bg-surface-1 p-6 shadow-float"
        >
          <div className="flex items-start gap-3">
            <ChannelTypeTile type={type} className="h-9 w-9" />
            <div className="flex min-w-0 flex-col gap-1">
              <DialogTitle className="m-0 text-[16px] font-semibold leading-6">
                {channel ? `Edit ${channelLabel(channel)}` : `Connect ${typeLabel}`}
              </DialogTitle>
              <Description className="m-0 text-[13px] text-ink-muted">
                {editing ? 'Secrets are never shown again. Leave a field empty to keep what is stored.' : CHANNEL_PITCH[type]}
              </Description>
            </div>
          </div>

          <Input
            label="Name"
            size="lg"
            value={form.name}
            maxLength={MAX_CHANNEL_NAME_LENGTH}
            autoComplete="off"
            error={errors.name}
            hint="Shown on this page and in the rule editor."
            onChange={(event) => {
              set({ name: event.target.value });
            }}
          />

          {type === 'email' && (
            <EmailListInput
              label="Recipients"
              value={form.recipients}
              draft={recipientDraft}
              onDraftChange={setRecipientDraft}
              onChange={(recipients) => {
                set({ recipients });
              }}
              error={errors.recipients}
              hint={
                editing
                  ? `Currently ${summary.recipients ?? 'set'}. Enter the full list to replace it, or leave it empty to keep it.`
                  : 'Up to 10 addresses. Press Enter, comma or space after each one.'
              }
            />
          )}

          {(type === 'slack' || type === 'discord') && (
            <Input
              label="Webhook URL"
              size="lg"
              type="url"
              className="num text-[13px]"
              value={form.webhookUrl}
              autoComplete="off"
              spellCheck={false}
              placeholder={type === 'slack' ? 'https://hooks.slack.com/services/…' : 'https://discord.com/api/webhooks/…'}
              error={errors.webhookUrl}
              hint={
                editing
                  ? keepHint(summary.destination, 'URL')
                  : type === 'slack'
                    ? 'In Slack: Apps › Incoming Webhooks › Add to Slack, pick a channel, copy the URL.'
                    : 'In Discord: channel settings › Integrations › Webhooks › New Webhook › Copy Webhook URL.'
              }
              onChange={(event) => {
                set({ webhookUrl: event.target.value });
              }}
            />
          )}

          {type === 'telegram' && (
            <>
              <SecretInput
                label="Bot token"
                value={form.telegramToken}
                error={errors.telegramToken}
                placeholder="123456789:AA…"
                hint={editing ? 'Enter the token and chat id together to change them; leave both empty to keep them.' : 'Create a bot with @BotFather (/newbot) and paste the token it gives you.'}
                onChange={(telegramToken) => {
                  set({ telegramToken });
                }}
              />
              <Input
                label="Chat id"
                size="lg"
                className="num text-[13px]"
                value={form.telegramChatId}
                autoComplete="off"
                spellCheck={false}
                placeholder="-1001234567890 or @yourchannel"
                error={errors.telegramChatId}
                hint={
                  editing
                    ? `Currently ${summary.chat ?? 'set'}.`
                    : 'Message your bot (or add it to a group), then read chat.id from api.telegram.org/bot<token>/getUpdates.'
                }
                onChange={(event) => {
                  set({ telegramChatId: event.target.value });
                }}
              />
            </>
          )}

          {type === 'webhook' && (
            <>
              <Input
                label="URL"
                size="lg"
                type="url"
                className="num text-[13px]"
                value={form.webhookUrl}
                autoComplete="off"
                spellCheck={false}
                placeholder="https://hooks.yourteam.dev/monitaur"
                error={errors.webhookUrl}
                hint={editing ? keepHint(summary.url, 'URL and secret') : 'Monitaur POSTs a JSON body for every incident event.'}
                onChange={(event) => {
                  set({ webhookUrl: event.target.value });
                }}
              />
              <SecretInput
                label={
                  <>
                    Signing secret <span className="font-normal text-ink-faint">(optional)</span>
                  </>
                }
                value={form.webhookSecret}
                maxLength={MAX_WEBHOOK_SECRET_LENGTH}
                error={errors.webhookSecret}
                placeholder={editing && summary.signed === 'yes' ? 'Stored; enter it again to change the URL' : 'A long random string'}
                hint="Signs every request with HMAC-SHA256 so you can reject forged ones."
                onChange={(webhookSecret) => {
                  set({ webhookSecret });
                }}
              />
              <SignatureNote />
            </>
          )}

          {(limitReached || atLimit) && (
            <LimitReachedHint
              resource="channels"
              used={usage?.channels}
              limit={plan?.max_channels}
              planName={plan?.name}
              action="Reuse or delete an existing channel."
            />
          )}
          {generalError && (
            <div role="alert" className="rounded bg-tint-crit px-3 py-2.5 text-[13px] text-crit">
              {generalError}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {channel && (
              <Button
                variant="ghost"
                className="!text-crit"
                onClick={() => {
                  remove.reset();
                  setConfirmDelete(true);
                }}
              >
                Delete channel
              </Button>
            )}
            <span className="flex-1" />
            <Button variant="ghost" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={pending} disabled={atLimit}>
              {editing ? 'Save channel' : `Connect ${typeLabel}`}
            </Button>
          </div>

          {channel && (
            <ConfirmDialog
              open={confirmDelete}
              onClose={() => {
                setConfirmDelete(false);
              }}
              onConfirm={confirmRemove}
              title={`Delete ${channelLabel(channel)}?`}
              description="Rules that notify this channel stop notifying it. Its stored secrets are deleted."
              confirmLabel="Delete channel"
              pending={remove.isPending}
              error={remove.error ? errorMessage(remove.error) : undefined}
            />
          )}
        </DialogPanel>
      </div>
    </Dialog>
  );
}

interface SecretInputProps {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  placeholder?: string;
  maxLength?: number;
}

/** A password-style field with Show/Hide, for tokens and secrets typed once. */
function SecretInput({ label, value, onChange, error, hint, placeholder, maxLength }: SecretInputProps) {
  const [revealed, setRevealed] = useState(false);
  return (
    <Input
      label={label}
      size="lg"
      type={revealed ? 'text' : 'password'}
      className="num pr-16 text-[13px]"
      value={value}
      maxLength={maxLength}
      autoComplete="new-password"
      spellCheck={false}
      placeholder={placeholder}
      error={error}
      hint={hint}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      trailing={
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setRevealed((current) => !current);
          }}
          aria-pressed={revealed}
        >
          {revealed ? 'Hide' : 'Show'}
        </Button>
      }
    />
  );
}
