import { Description, Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { GlobeAltIcon } from '@heroicons/react/24/outline';
import { useId, useState, type FormEvent } from 'react';

import { errorMessage, hasErrorCode, isApiError } from '../../api/errors';
import type { Channel, Check, CheckType } from '../../api/types';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Input } from '../../components/Input';
import { hintClasses, labelClasses } from '../../components/inputClasses';
import { LimitReachedHint } from '../../components/LimitReachedHint';
import { SegmentedControl } from '../../components/SegmentedControl';
import { Select } from '../../components/Select';
import { useToast } from '../../components/toastContext';
import { Toggle } from '../../components/Toggle';
import { useCreateCheck, useDeleteCheck, useUpdateCheck } from '../../hooks/api/checks';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { CHECK_TYPE_LABELS, CHECK_TYPES } from '../../lib/checks';
import { cn } from '../../lib/cn';
import { ChannelPicker } from '../rules/ChannelPicker';

import {
  buildCreateBody,
  buildUpdateBody,
  emptyCheckForm,
  formatInterval,
  formFromCheck,
  formReportsTls,
  hasErrors,
  intervalOptions,
  MAX_CHECK_NAME_LENGTH,
  MAX_EXPECT_STATUS,
  MAX_KEYWORD_LENGTH,
  MAX_TLS_WARN_DAYS,
  MIN_EXPECT_STATUS,
  MIN_TLS_WARN_DAYS,
  TARGET_COPY,
  timeoutOptions,
  TYPE_PITCH,
  validateCheckForm,
  type CheckForm,
  type CheckFormErrors,
  type CheckLimits,
  type CheckQuotaState,
} from './checkModel';

export interface CheckDialogProps {
  /** Present when editing. */
  check: Check | null;
  channels: readonly Channel[];
  limits: CheckLimits;
  quota: CheckQuotaState | null;
  canEdit: boolean;
  onClose: () => void;
  /** After a delete, e.g. to leave the detail page. */
  onDeleted?: () => void;
}

/** Which field an `invalid` message from the API belongs to, by keyword. */
function fieldForApiError(message: string): keyof CheckFormErrors | null {
  const text = message.toLowerCase();
  if (text.includes('interval')) return 'interval';
  if (text.includes('timeout')) return 'timeout';
  if (text.includes('target') || text.includes('url') || text.includes('host') || text.includes('port') || text.includes('private')) return 'target';
  if (text.includes('name')) return 'name';
  if (text.includes('status')) return 'expectStatus';
  if (text.includes('keyword')) return 'keyword';
  if (text.includes('tls') || text.includes('warn')) return 'tlsWarnDays';
  return null;
}

/**
 * New and edit forms for an uptime check, per type: http (URL, expected
 * status, keyword), tcp (host:port), tls (host:port, warning days), plus the
 * interval (never under the plan minimum), timeout and channels.
 */
export function CheckDialog({ check, channels, limits, quota, canEdit, onClose, onDeleted }: CheckDialogProps) {
  const desktop = useIsDesktop();
  const { toast } = useToast();
  const create = useCreateCheck();
  const update = useUpdateCheck();
  const remove = useDeleteCheck();
  const typeLabelId = useId();
  const channelsLabelId = useId();
  const [form, setForm] = useState<CheckForm>(() => (check ? formFromCheck(check) : emptyCheckForm(limits, channels)));
  const [attempted, setAttempted] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const editing = check !== null;
  const mutation = editing ? update : create;
  const limitReached = hasErrorCode(mutation.error, 'limit_reached');
  const apiMessage = isApiError(mutation.error) && mutation.error.code === 'invalid' ? mutation.error.message : null;
  const apiField = apiMessage === null ? null : fieldForApiError(apiMessage);
  const clientErrors = attempted ? validateCheckForm(form, limits) : {};
  const errors: CheckFormErrors = apiField && apiMessage ? { ...clientErrors, [apiField]: apiMessage } : clientErrors;
  const generalError = mutation.error && !limitReached && apiField === null ? errorMessage(mutation.error) : null;
  const atLimit = !editing && quota?.atLimit === true;
  const pending = create.isPending || update.isPending;
  const disabled = !canEdit;
  const target = TARGET_COPY[form.type];
  const tlsField = formReportsTls(form);

  const set = (patch: Partial<CheckForm>): void => {
    setForm((current) => ({ ...current, ...patch }));
    if (mutation.error) mutation.reset();
  };

  const setTarget = (value: string): void => {
    set({ targets: { ...form.targets, [form.type]: value } });
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setAttempted(true);
    if (!canEdit || hasErrors(validateCheckForm(form, limits))) return;
    if (check) {
      const body = buildUpdateBody(check, form);
      if (Object.keys(body).length === 0) {
        onClose();
        return;
      }
      update.mutate(
        { checkId: check.id, body },
        {
          onSuccess: ({ check: saved }) => {
            toast({ tone: 'success', title: `${saved.name} saved` });
            onClose();
          },
        },
      );
      return;
    }
    create.mutate(buildCreateBody(form), {
      onSuccess: ({ check: created }) => {
        toast({ tone: 'success', title: `${created.name} created`, description: 'The first result lands within one interval. Use Run now to check right away.' });
        onClose();
      },
    });
  };

  const confirmRemove = (): void => {
    if (!check) return;
    remove.mutate(check.id, {
      onSuccess: () => {
        toast({ tone: 'success', title: `${check.name} deleted` });
        setConfirmDelete(false);
        onClose();
        onDeleted?.();
      },
    });
  };

  return (
    <Dialog open onClose={pending ? () => undefined : onClose} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-scrim" />
      <div className={cn('fixed inset-0 flex justify-center overflow-y-auto p-4', desktop ? 'items-center' : 'items-end')}>
        <DialogPanel
          as="form"
          noValidate
          onSubmit={submit}
          className="flex w-full max-w-[560px] flex-col gap-4 rounded-xl border border-line-strong bg-surface-1 p-6 shadow-float"
        >
          <div className="flex items-start gap-3">
            <span className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-tint-accent text-accent">
              <GlobeAltIcon className="h-5 w-5" strokeWidth={1.6} aria-hidden="true" />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <DialogTitle className="m-0 text-[16px] font-semibold leading-6 [overflow-wrap:anywhere]">
                {check ? `Edit ${check.name}` : 'New uptime check'}
              </DialogTitle>
              <Description className="m-0 text-[13px] text-ink-muted">
                Runs from the Monitaur backend. Two failures in a row open a critical incident; two successes resolve it.
              </Description>
            </div>
          </div>

          {/* Up top, so a full plan is the first thing read, not something found after filling the form. */}
          {(limitReached || atLimit) && (
            <LimitReachedHint
              resource="uptime checks"
              used={quota?.used}
              limit={quota?.limit}
              planName={quota?.planName}
              action="Delete a check you no longer need."
            />
          )}

          <fieldset disabled={disabled} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
            <div className="flex flex-col gap-1.5">
              <span id={typeLabelId} className={labelClasses}>
                Type
              </span>
              <SegmentedControl<CheckType>
                aria-label="Check type"
                className="self-start"
                size={desktop ? 'md' : 'touch'}
                value={form.type}
                onChange={(type) => {
                  if (!disabled) set({ type });
                }}
                options={CHECK_TYPES.map((type) => ({ value: type, label: CHECK_TYPE_LABELS[type] }))}
              />
              <span className={hintClasses}>{TYPE_PITCH[form.type]}</span>
            </div>

            <Input
              label="Name"
              size="lg"
              value={form.name}
              maxLength={MAX_CHECK_NAME_LENGTH}
              autoComplete="off"
              placeholder={form.type === 'http' ? 'API health' : form.type === 'tcp' ? 'Postgres port' : 'Website certificate'}
              // Headless UI Dialog focuses the element marked data-autofocus.
              {...(editing ? {} : { 'data-autofocus': true })}
              error={errors.name}
              hint="Shown in incidents, notifications and on the status page."
              onChange={(event) => {
                set({ name: event.target.value });
              }}
            />

            <Input
              key={form.type}
              label={target.label}
              size="lg"
              type={form.type === 'http' ? 'url' : 'text'}
              inputMode={form.type === 'http' ? 'url' : 'text'}
              className="num text-[13px]"
              value={form.targets[form.type]}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={target.placeholder}
              error={errors.target}
              hint={target.hint}
              onChange={(event) => {
                setTarget(event.target.value);
              }}
            />

            {form.type === 'http' && (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
                <Input
                  label="Expected status"
                  size="lg"
                  inputMode="numeric"
                  className="num"
                  value={form.expectStatus}
                  placeholder="any 2xx or 3xx"
                  error={errors.expectStatus}
                  hint={`${MIN_EXPECT_STATUS} to ${MAX_EXPECT_STATUS}, or empty.`}
                  onChange={(event) => {
                    set({ expectStatus: event.target.value.replace(/\D/g, '') });
                  }}
                />
                <Input
                  label={
                    <>
                      Keyword <span className="font-normal text-ink-faint">(optional)</span>
                    </>
                  }
                  size="lg"
                  value={form.keyword}
                  maxLength={MAX_KEYWORD_LENGTH}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="ok"
                  error={errors.keyword}
                  hint="The body (first 1 MB) must contain it."
                  onChange={(event) => {
                    set({ keyword: event.target.value });
                  }}
                />
              </div>
            )}

            {tlsField && (
              <Input
                label="Certificate warning"
                size="lg"
                inputMode="numeric"
                className="num"
                fieldClassName="max-w-[260px]"
                value={form.tlsWarnDays}
                error={errors.tlsWarnDays}
                trailing={<span className="pr-2 text-[13px] text-ink-faint">days</span>}
                hint={`Opens a warning incident when the certificate expires within this many days (${MIN_TLS_WARN_DAYS} to ${MAX_TLS_WARN_DAYS}).`}
                onChange={(event) => {
                  set({ tlsWarnDays: event.target.value.replace(/\D/g, '') });
                }}
              />
            )}

            <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
              <div className="flex flex-col gap-1.5">
                <Select<number>
                  label="Interval"
                  size="lg"
                  value={form.intervalSeconds}
                  options={intervalOptions(limits.minIntervalSeconds, form.intervalSeconds)}
                  disabled={disabled}
                  onChange={(intervalSeconds) => {
                    set({ intervalSeconds });
                  }}
                />
                <FieldMessage
                  error={errors.interval}
                  hint={limits.minIntervalSeconds > 0 ? `Your plan allows every ${formatInterval(limits.minIntervalSeconds)} or slower.` : undefined}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Select<number>
                  label="Timeout"
                  size="lg"
                  value={form.timeoutSeconds}
                  options={timeoutOptions(form.timeoutSeconds)}
                  disabled={disabled}
                  onChange={(timeoutSeconds) => {
                    set({ timeoutSeconds });
                  }}
                />
                <FieldMessage error={errors.timeout} hint="A slower answer counts as a failure." />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <span id={channelsLabelId} className={labelClasses}>
                Notify
              </span>
              <div role="group" aria-labelledby={channelsLabelId}>
                <ChannelPicker
                  channels={channels}
                  value={form.channelIds}
                  disabled={disabled}
                  onChange={(channelIds) => {
                    set({ channelIds });
                  }}
                />
              </div>
              <span className={hintClasses}>Down, recovered and certificate warnings go here. Maintenance windows silence them.</span>
            </div>

            <Toggle
              label="Enabled"
              description={editing ? 'Paused checks keep their history but stop running.' : 'Start checking as soon as it is saved.'}
              checked={form.enabled}
              disabled={disabled}
              onChange={(enabled) => {
                set({ enabled });
              }}
            />
          </fieldset>

          {generalError && (
            <div role="alert" className="rounded bg-tint-crit px-3 py-2.5 text-[13px] text-crit">
              {generalError}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {check && (
              <Button
                variant="ghost"
                className="!text-crit"
                disabled={disabled}
                title={disabled ? 'Viewers can’t delete uptime checks' : undefined}
                onClick={() => {
                  remove.reset();
                  setConfirmDelete(true);
                }}
              >
                Delete check
              </Button>
            )}
            <span className="flex-1" />
            <Button variant="ghost" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={pending}
              disabled={disabled || atLimit}
              title={disabled ? 'Viewers can’t change uptime checks' : undefined}
            >
              {editing ? 'Save check' : 'Create check'}
            </Button>
          </div>

          {check && (
            <ConfirmDialog
              open={confirmDelete}
              onClose={() => {
                setConfirmDelete(false);
              }}
              onConfirm={confirmRemove}
              title={`Delete ${check.name}?`}
              description="Its results and incidents are deleted too, and it leaves the status page."
              confirmLabel="Delete check"
              pending={remove.isPending}
              error={remove.error ? errorMessage(remove.error) : undefined}
            />
          )}
        </DialogPanel>
      </div>
    </Dialog>
  );
}

function FieldMessage({ error, hint }: { error: string | undefined; hint: string | undefined }) {
  if (error) {
    return (
      <span role="alert" className="text-[12px] leading-4 text-crit">
        {error}
      </span>
    );
  }
  return hint ? <span className={hintClasses}>{hint}</span> : null;
}
