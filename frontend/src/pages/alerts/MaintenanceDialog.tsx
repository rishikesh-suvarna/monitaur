import { Description, Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { WrenchScrewdriverIcon } from '@heroicons/react/24/outline';
import { useId, useState, type FormEvent } from 'react';

import { errorMessage } from '../../api/errors';
import type { Check, MaintenanceWindow, ServerSummary } from '../../api/types';
import { Button } from '../../components/Button';
import { ChipButton } from '../../components/Chip';
import { Input } from '../../components/Input';
import { hintClasses, labelClasses } from '../../components/inputClasses';
import { SegmentedControl } from '../../components/SegmentedControl';
import { StatusIcon } from '../../components/StatusBadge';
import { useToast } from '../../components/toastContext';
import { useCreateMaintenance, useUpdateMaintenance } from '../../hooks/api/maintenance';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { useNow } from '../../hooks/useNow';
import { cn } from '../../lib/cn';
import { formatDayTime, toTime } from '../../lib/format';
import { ScopePicker } from '../rules/ScopePicker';

import {
  buildCreateBody,
  buildUpdateBody,
  DURATION_PRESETS,
  emptyMaintenanceForm,
  formatWindowLength,
  formFromWindow,
  formTimes,
  hasMaintenanceErrors,
  maintenanceState,
  MAX_WINDOW_NAME_LENGTH,
  validateMaintenanceForm,
  windowCoversServer,
  formScope,
  type DurationChoice,
  type MaintenanceForm,
  toLocalInput,
  type StartMode,
} from './maintenanceModel';

const MS_PER_SECOND = 1000;
const CUSTOM = 'custom';

export interface MaintenanceDialogProps {
  /** Present when editing (scheduled or active windows only). */
  existing: MaintenanceWindow | null;
  servers: readonly ServerSummary[];
  checks: readonly Check[];
  onClose: () => void;
}

function FieldError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <span role="alert" className="inline-flex items-center gap-1 text-[12px] leading-4 text-crit">
      <StatusIcon status="critical" size={12} />
      {message}
    </span>
  );
}

/**
 * New and edit forms for a maintenance window: name, start (now or at a
 * time), a duration preset or a custom end, and what it covers (everything,
 * or servers, tags and checks). An active window keeps its start.
 */
export function MaintenanceDialog({ existing, servers, checks, onClose }: MaintenanceDialogProps) {
  const desktop = useIsDesktop();
  const now = useNow();
  const { toast } = useToast();
  const create = useCreateMaintenance();
  const update = useUpdateMaintenance();
  const startLabelId = useId();
  const durationLabelId = useId();
  const checksLabelId = useId();
  const scopeHintId = useId();
  const [form, setForm] = useState<MaintenanceForm>(() => (existing ? formFromWindow(existing) : emptyMaintenanceForm(Date.now())));
  const [attempted, setAttempted] = useState(false);

  const editing = existing !== null;
  const activeWindow = existing !== null && maintenanceState(existing, now) === 'active' ? existing : null;
  const fixedStart = activeWindow ? toTime(activeWindow.starts_at) : null;
  const mutation = editing ? update : create;
  const pending = mutation.isPending;
  const errors = attempted ? validateMaintenanceForm(form, { now, fixedStart }) : {};
  const times = formTimes(form, now, fixedStart);
  const scope = formScope(form);
  const coveredServers = servers.filter((server) => windowCoversServer(scope, server)).length;
  const coveredChecks = scope.all ? checks.length : scope.check_ids.length;

  const set = (patch: Partial<MaintenanceForm>): void => {
    setForm((current) => ({ ...current, ...patch }));
    if (mutation.error) mutation.reset();
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setAttempted(true);
    const at = Date.now();
    if (hasMaintenanceErrors(validateMaintenanceForm(form, { now: at, fixedStart }))) return;
    if (existing) {
      const body = buildUpdateBody(existing, form, at);
      if (!body) return;
      if (Object.keys(body).length === 0) {
        onClose();
        return;
      }
      update.mutate(
        { windowId: existing.id, body },
        {
          onSuccess: () => {
            toast({ tone: 'success', title: `${form.name.trim()} saved` });
            onClose();
          },
        },
      );
      return;
    }
    const body = buildCreateBody(form, at);
    if (!body) return;
    create.mutate(body, {
      onSuccess: () => {
        toast({
          tone: 'success',
          title: form.startMode === 'now' ? 'Maintenance started' : 'Maintenance scheduled',
          description: 'Incidents in scope are still recorded, but nobody is notified until it ends.',
        });
        onClose();
      },
    });
  };

  const durationOptions = [
    ...DURATION_PRESETS.map((seconds) => ({ value: String(seconds), label: formatWindowLength(seconds) })),
    { value: CUSTOM, label: 'Custom end' },
  ];

  const toggleCheck = (id: number): void => {
    set({ checkIds: form.checkIds.includes(id) ? form.checkIds.filter((item) => item !== id) : [...form.checkIds, id] });
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
              <WrenchScrewdriverIcon className="h-5 w-5" strokeWidth={1.6} aria-hidden="true" />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <DialogTitle className="m-0 text-[16px] font-semibold leading-6 [overflow-wrap:anywhere]">
                {existing ? `Edit ${existing.name}` : 'New maintenance window'}
              </DialogTitle>
              <Description className="m-0 text-[13px] text-ink-muted">
                While it is active, incidents in scope are recorded and marked Silenced. No channel is notified: not when they fire, remind or resolve.
              </Description>
            </div>
          </div>

          <Input
            label="Name"
            size="lg"
            value={form.name}
            maxLength={MAX_WINDOW_NAME_LENGTH}
            autoComplete="off"
            placeholder="Postgres 17 upgrade"
            // Headless UI Dialog focuses the element marked data-autofocus.
            {...(editing ? {} : { 'data-autofocus': true })}
            error={errors.name}
            onChange={(event) => {
              set({ name: event.target.value });
            }}
          />

          <div className="flex flex-col gap-1.5">
            <span id={startLabelId} className={labelClasses}>
              Start
            </span>
            {activeWindow ? (
              <span className="num text-[13px] text-ink-muted">Started {formatDayTime(activeWindow.starts_at, now)}. An active window keeps its start.</span>
            ) : (
              <>
                <SegmentedControl<StartMode>
                  aria-label="Start"
                  className="self-start"
                  size={desktop ? 'md' : 'touch'}
                  value={form.startMode}
                  onChange={(startMode) => {
                    set({ startMode });
                  }}
                  options={[
                    { value: 'now', label: 'Now' },
                    { value: 'scheduled', label: 'At a time' },
                  ]}
                />
                {form.startMode === 'scheduled' && (
                  <Input
                    label="Start time"
                    hideLabel
                    type="datetime-local"
                    size="lg"
                    className="num"
                    fieldClassName="max-w-[280px]"
                    value={form.startLocal}
                    error={errors.start}
                    onChange={(event) => {
                      set({ startLocal: event.target.value });
                    }}
                  />
                )}
              </>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <span id={durationLabelId} className={labelClasses}>
              Duration
            </span>
            <SegmentedControl<string>
              aria-label="Duration"
              className="self-start"
              size={desktop ? 'md' : 'touch'}
              value={form.duration === 'custom' ? CUSTOM : String(form.duration)}
              onChange={(value) => {
                const duration: DurationChoice = value === CUSTOM ? 'custom' : Number(value);
                // Seed the custom end from the current one so switching does not jump.
                set(duration === 'custom' && times ? { duration, endLocal: toLocalInput(times.end) } : { duration });
              }}
              options={durationOptions}
            />
            {form.duration === 'custom' && (
              <Input
                label="End time"
                hideLabel
                type="datetime-local"
                size="lg"
                className="num"
                fieldClassName="max-w-[280px]"
                value={form.endLocal}
                onChange={(event) => {
                  set({ endLocal: event.target.value });
                }}
              />
            )}
            <FieldError message={errors.end} />
            {times && times.end > times.start && (
              <span className={cn(hintClasses, 'num')}>
                {formatDayTime(times.start, now)} to {formatDayTime(times.end, now)} · {formatWindowLength((times.end - times.start) / MS_PER_SECOND)}
              </span>
            )}
          </div>

          <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
            <legend className="mb-2 p-0 text-[13px] font-medium text-ink">Covers</legend>
            <SegmentedControl
              aria-label="Scope"
              className="self-start"
              size={desktop ? 'md' : 'touch'}
              value={form.scopeAll ? 'all' : 'some'}
              onChange={(value) => {
                set({ scopeAll: value === 'all' });
              }}
              options={[
                { value: 'all', label: 'Everything' },
                { value: 'some', label: 'Servers, tags or checks' },
              ]}
            />
            {!form.scopeAll && (
              <>
                <ScopePicker
                  servers={servers}
                  serverIds={form.serverIds}
                  tags={form.tags}
                  invalid={Boolean(errors.scope)}
                  describedBy={scopeHintId}
                  onChange={({ serverIds, tags }) => {
                    set({ serverIds, tags });
                  }}
                />
                <div className="flex flex-col gap-1.5">
                  <span id={checksLabelId} className="text-[12px] font-medium text-ink-muted">
                    Uptime checks
                  </span>
                  {checks.length === 0 ? (
                    <span className={hintClasses}>No uptime checks yet.</span>
                  ) : (
                    <div role="group" aria-labelledby={checksLabelId} className="flex flex-wrap gap-1.5">
                      {checks.map((check) => (
                        <ChipButton
                          key={check.id}
                          size={desktop ? 'md' : 'touch'}
                          pressed={form.checkIds.includes(check.id)}
                          className="max-w-full"
                          title={check.name}
                          onClick={() => {
                            toggleCheck(check.id);
                          }}
                        >
                          <span className="truncate">{check.name}</span>
                        </ChipButton>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
            <span id={scopeHintId} className={hintClasses}>
              Covers {coveredServers === 1 ? '1 server' : `${coveredServers} servers`} and {coveredChecks === 1 ? '1 check' : `${coveredChecks} checks`} today
              {!form.scopeAll && form.tags.length > 0 ? `; servers tagged ${form.tags.join(' or ')} later are covered too.` : '.'}
            </span>
            <FieldError message={errors.scope} />
          </fieldset>

          {mutation.error && (
            <div role="alert" className="rounded bg-tint-crit px-3 py-2.5 text-[13px] text-crit">
              {errorMessage(mutation.error)}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={pending}>
              {editing ? 'Save window' : form.startMode === 'now' ? 'Start maintenance' : 'Schedule maintenance'}
            </Button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
