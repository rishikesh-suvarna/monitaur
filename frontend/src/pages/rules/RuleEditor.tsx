import { PencilSquareIcon } from '@heroicons/react/24/outline';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { useBlocker } from 'react-router-dom';

import { errorMessage, hasErrorCode, isApiError } from '../../api/errors';
import type { Channel, Comparison, MetricKey, Rule, RuleInput, ServerSummary, Severity } from '../../api/types';
import { Button } from '../../components/Button';
import { cardClasses } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Input } from '../../components/Input';
import { hintClasses, inputClasses } from '../../components/inputClasses';
import { LimitReachedHint } from '../../components/LimitReachedHint';
import { RelativeTime } from '../../components/RelativeTime';
import { SegmentedControl } from '../../components/SegmentedControl';
import { StatusIcon } from '../../components/StatusBadge';
import { useToast } from '../../components/toastContext';
import { Toggle } from '../../components/Toggle';
import { useOrgDetails } from '../../hooks/api/org';
import { useCreateRule, useDeleteRule, useUpdateRule } from '../../hooks/api/rules';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { channelLabel } from '../../lib/channels';
import { cn } from '../../lib/cn';
import { METRIC_LABELS } from '../../lib/status';
import { usageState } from '../../lib/usage';

import { ChannelPicker } from './ChannelPicker';
import { InlineSelect, type InlineOption } from './InlineSelect';
import {
  AUTO_RESOLVE_OPTIONS,
  COOLDOWN_OPTIONS,
  countMatched,
  displayUnit,
  draftFromRule,
  draftScope,
  draftToInput,
  durationOptions,
  fieldForApiError,
  FOR_OPTIONS,
  formatRuleDuration,
  hasErrors,
  isPercentMetric,
  MAX_RULE_NAME_LENGTH,
  newDraft,
  RULE_METRICS,
  ruleSentence,
  sameInput,
  updateDraft,
  validateDraft,
  type RuleDraft,
  type RuleErrors,
} from './ruleModel';
import { RulePreview } from './RulePreview';
import { ScopePicker } from './ScopePicker';

const METRIC_OPTIONS: InlineOption<MetricKey>[] = RULE_METRICS.map((metric) => ({ value: metric, label: METRIC_LABELS[metric] }));
const COMPARISON_OPTIONS: InlineOption<Comparison>[] = [
  { value: 'above', label: 'above' },
  { value: 'below', label: 'below' },
];
const SEVERITY_OPTIONS: InlineOption<Severity>[] = [
  { value: 'warning', label: 'Warning' },
  { value: 'critical', label: 'Critical' },
];
const SEVERITY_TONE: Record<Severity, string> = {
  warning: '!border-warn !text-warn',
  critical: '!border-crit !text-crit',
};
/** Width of the switch plus its gap, so timer hints line up under the label. */
const TOGGLE_INDENT = 'pl-[46px]';

const durationChoices = (presets: readonly number[], current: number): InlineOption<number>[] =>
  durationOptions(presets, current).map((seconds) => ({ value: seconds, label: formatRuleDuration(seconds) }));

const withoutEnabled = ({ enabled: _enabled, ...rest }: RuleInput): Omit<RuleInput, 'enabled'> => rest;

export interface RuleEditorProps {
  rule: Rule | null;
  /** Pre-scope a new rule to this server (/rules?new=1&server=<id>). */
  initialServerId: number | null;
  servers: readonly ServerSummary[];
  channels: readonly Channel[];
  canEdit: boolean;
  /** Leave the editor (Cancel on a new rule, after delete). */
  onClose: () => void;
  /** Cancel on an existing rule, after the draft was reset. */
  onCancelEdit: () => void;
  onCreated: (rule: Rule) => void;
  ref?: Ref<HTMLElement>;
}

/** The Rules.dc.html editor card for creating and editing one rule. */
export function RuleEditor({ rule, initialServerId, servers, channels, canEdit, onClose, onCancelEdit, onCreated, ref }: RuleEditorProps) {
  const desktop = useIsDesktop();
  const { toast } = useToast();
  const org = useOrgDetails();
  const create = useCreateRule();
  const update = useUpdateRule();
  const remove = useDeleteRule();
  const headingId = useId();
  const conditionId = useId();
  const sentenceId = useId();
  const scopeHintId = useId();

  const [initial, setInitial] = useState<RuleDraft>(() => (rule ? draftFromRule(rule) : newDraft({ serverId: initialServerId, channels })));
  const [draft, setDraft] = useState<RuleDraft>(initial);
  const [attempted, setAttempted] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const leaving = useRef(false);

  const isNew = rule === null;
  const input = useMemo(() => draftToInput(draft), [draft]);
  const initialInput = useMemo(() => draftToInput(initial), [initial]);
  const dirty = !sameInput({ ...withoutEnabled(input), enabled: true }, { ...withoutEnabled(initialInput), enabled: true });
  const clientErrors = validateDraft(draft);
  const saving = create.isPending || update.isPending;

  const mutationError = isNew ? create.error : update.error;
  const limitReached = hasErrorCode(mutationError, 'limit_reached');
  const apiMessage = isApiError(mutationError) && mutationError.code === 'invalid' ? mutationError.message : null;
  const apiField = apiMessage === null ? null : fieldForApiError(apiMessage);
  const visibleClientErrors: RuleErrors = attempted ? clientErrors : { ...clientErrors, name: undefined, scope: undefined };
  const errors: RuleErrors = apiField && apiMessage ? { ...visibleClientErrors, [apiField]: apiMessage } : visibleClientErrors;
  const generalError = mutationError && !limitReached && apiField === null ? errorMessage(mutationError) : null;

  const plan = org.data?.plan;
  const usage = org.data?.usage;
  const atRuleLimit = isNew && plan !== undefined && usage !== undefined && usageState(usage.rules, plan.max_rules).atLimit;

  const serverNames = useMemo(() => new Map(servers.map((server) => [server.id, server.name])), [servers]);
  const channelNames = useMemo(() => {
    const byId = new Map(channels.map((channel) => [channel.id, channel]));
    return draft.channelIds.flatMap((id) => {
      const channel = byId.get(id);
      return channel ? [channelLabel(channel)] : [];
    });
  }, [channels, draft.channelIds]);
  const matched = countMatched(draftScope(draft), servers);
  const heartbeat = draft.metric === 'heartbeat';
  const disabled = !canEdit;

  // Leaving with unsaved edits asks first; saving, deleting and Cancel opt out.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && !leaving.current && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search),
  );
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [dirty]);

  const change = (patch: Partial<RuleDraft>): void => {
    setDraft((current) => updateDraft(current, patch));
    if (create.error) create.reset();
    if (update.error) update.reset();
  };

  const leave = (navigate: () => void): void => {
    leaving.current = true;
    navigate();
  };

  const save = (): void => {
    setAttempted(true);
    if (hasErrors(clientErrors) || disabled) return;
    if (isNew) {
      create.mutate(input, {
        onSuccess: ({ rule: created }) => {
          toast({ title: 'Rule created', description: created.name, tone: 'success' });
          leave(() => {
            onCreated(created);
          });
        },
      });
      return;
    }
    update.mutate(
      { ruleId: rule.id, patch: withoutEnabled(input) },
      {
        onSuccess: ({ rule: saved }) => {
          const next = draftFromRule(saved);
          setInitial(next);
          setDraft(next);
          setAttempted(false);
          toast({ title: 'Rule saved', description: saved.name, tone: 'success' });
        },
      },
    );
  };

  const cancel = (): void => {
    setDraft(initial);
    setAttempted(false);
    create.reset();
    update.reset();
    leave(isNew ? onClose : onCancelEdit);
    leaving.current = false;
  };

  const confirmRemove = (): void => {
    if (!rule) return;
    remove.mutate(rule.id, {
      onSuccess: () => {
        setConfirmDelete(false);
        toast({ title: 'Rule deleted', description: rule.name, tone: 'success' });
        leave(onClose);
      },
    });
  };

  const readOnlyTitle = disabled ? 'Viewers can’t change alert rules' : undefined;

  return (
    <section ref={ref} aria-labelledby={headingId} className={cn(cardClasses, 'flex min-w-0 flex-[999_1_520px] scroll-mt-4 flex-col')}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-5 py-4">
        <h2 id={headingId} className="m-0 flex-1 whitespace-nowrap text-[16px] font-semibold leading-6">
          {isNew ? 'New rule' : 'Edit rule'}
        </h2>
        {dirty && !isNew && <span className="text-[12px] text-ink-muted">Unsaved changes</span>}
        {rule && (
          <span className="num text-[12px] text-ink-faint">
            {rule.name} · edited <RelativeTime value={rule.updated_at} />
          </span>
        )}
      </div>

      <div className="flex flex-col gap-5 p-5">
        <Input
          label="Name"
          className="num"
          fieldClassName="max-w-[360px]"
          value={draft.name}
          maxLength={MAX_RULE_NAME_LENGTH}
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          error={errors.name}
          hint="Shown on incidents and notifications."
          onChange={(event) => {
            change({ name: event.target.value, nameEdited: true });
          }}
        />

        <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" disabled={disabled}>
          <legend className="mb-2 p-0 text-[13px] font-medium text-ink">Applies to</legend>
          <SegmentedControl
            aria-label="Scope"
            className="self-start"
            size={desktop ? 'md' : 'touch'}
            value={draft.scopeAll ? 'all' : 'some'}
            onChange={(value) => {
              if (!disabled) change({ scopeAll: value === 'all' });
            }}
            options={[
              { value: 'all', label: 'All servers' },
              { value: 'some', label: 'Specific servers or tags' },
            ]}
          />
          {!draft.scopeAll && (
            <>
              <ScopePicker
                servers={servers}
                serverIds={draft.serverIds}
                tags={draft.tags}
                disabled={disabled}
                invalid={Boolean(errors.scope)}
                describedBy={scopeHintId}
                onChange={({ serverIds, tags }) => {
                  change({ serverIds, tags });
                }}
              />
              <span id={scopeHintId} className={hintClasses}>
                Matches {matched === 1 ? '1 server' : `${matched} servers`} today
                {draft.tags.length > 0 ? `; new servers tagged ${draft.tags.join(' or ')} are included automatically.` : '.'}
              </span>
            </>
          )}
          <FieldError message={errors.scope} />
        </fieldset>

        <div className="flex flex-col gap-2.5">
          <span id={conditionId} className="text-[13px] font-medium text-ink">
            Condition
          </span>
          <div
            role="group"
            aria-labelledby={conditionId}
            aria-describedby={sentenceId}
            className="flex flex-wrap items-center gap-2.5 rounded-lg border border-line bg-surface-2 p-4 text-[15px] leading-10"
          >
            <span>When</span>
            <InlineSelect
              label="Metric"
              value={draft.metric}
              options={METRIC_OPTIONS}
              disabled={disabled}
              invalid={Boolean(errors.metric)}
              onChange={(metric) => {
                change({ metric });
              }}
            />
            {heartbeat ? (
              <span>is missing</span>
            ) : (
              <>
                <span>is</span>
                <InlineSelect
                  label="Comparison"
                  value={draft.comparison}
                  options={COMPARISON_OPTIONS}
                  disabled={disabled}
                  onChange={(comparison) => {
                    change({ comparison });
                  }}
                />
                <ThresholdInput
                  value={draft.threshold}
                  unit={displayUnit(draft.metric)}
                  percent={isPercentMetric(draft.metric)}
                  invalid={Boolean(errors.threshold)}
                  disabled={disabled}
                  onChange={(threshold) => {
                    change({ threshold });
                  }}
                />
              </>
            )}
            <span>for</span>
            <InlineSelect
              label="Duration"
              value={draft.forSeconds}
              options={durationChoices(FOR_OPTIONS, draft.forSeconds)}
              disabled={disabled}
              invalid={Boolean(errors.for)}
              onChange={(forSeconds) => {
                change({ forSeconds });
              }}
            />
            <span>, raise</span>
            <InlineSelect
              label="Severity"
              value={draft.severity}
              options={SEVERITY_OPTIONS}
              disabled={disabled}
              className={SEVERITY_TONE[draft.severity]}
              onChange={(severity) => {
                change({ severity });
              }}
            />
            <span>, notify</span>
            <ChannelPicker
              channels={channels}
              value={draft.channelIds}
              disabled={disabled}
              onChange={(channelIds) => {
                change({ channelIds });
              }}
            />
          </div>
          <p id={sentenceId} className="sr-only">
            {ruleSentence(input, channelNames)}
          </p>
          <FieldError message={errors.metric ?? errors.threshold ?? errors.for ?? errors.severity ?? errors.channels} />
        </div>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
          <TimerCard
            label="Cooldown"
            checked={draft.cooldownOn}
            disabled={disabled}
            error={errors.cooldown}
            onChange={(cooldownOn) => {
              change({ cooldownOn });
            }}
          >
            {draft.cooldownOn ? (
              <>
                Re-notify at most every{' '}
                <InlineSelect
                  size="sm"
                  label="Cooldown interval"
                  value={draft.cooldownSeconds}
                  options={durationChoices(COOLDOWN_OPTIONS, draft.cooldownSeconds)}
                  disabled={disabled}
                  onChange={(cooldownSeconds) => {
                    change({ cooldownSeconds });
                  }}
                />{' '}
                while still firing.
              </>
            ) : (
              'Notifies once per incident, then stays quiet until it resolves.'
            )}
          </TimerCard>
          <TimerCard
            label="Auto-resolve"
            checked={draft.autoResolveOn}
            disabled={disabled}
            error={errors.autoResolve}
            onChange={(autoResolveOn) => {
              change({ autoResolveOn });
            }}
          >
            {draft.autoResolveOn ? (
              <>
                Close the incident after{' '}
                <InlineSelect
                  size="sm"
                  label="Auto-resolve after"
                  value={draft.autoResolveSeconds}
                  options={durationChoices(AUTO_RESOLVE_OPTIONS, draft.autoResolveSeconds)}
                  disabled={disabled}
                  onChange={(autoResolveSeconds) => {
                    change({ autoResolveSeconds });
                  }}
                />{' '}
                {heartbeat ? 'of heartbeats again.' : 'back under threshold.'}
              </>
            ) : heartbeat ? (
              'Closes as soon as a heartbeat arrives.'
            ) : (
              'Closes the moment the value is back under threshold.'
            )}
          </TimerCard>
        </div>

        <RulePreview
          input={hasErrors(clientErrors) ? null : input}
          blockedReason={Object.values(clientErrors)[0]}
          serverNames={serverNames}
        />

        {(limitReached || atRuleLimit) && (
          <LimitReachedHint
            resource="alert rules"
            used={usage?.rules}
            limit={plan?.max_rules}
            planName={plan?.name}
            action="Delete a rule you no longer need, or widen an existing rule’s scope."
          />
        )}
        {generalError && (
          <div role="alert" className="rounded bg-tint-crit px-3 py-2.5 text-[13px] text-crit">
            {generalError}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3.5">
        {rule && (
          <Button
            variant="ghost"
            className="!text-crit"
            disabled={disabled}
            title={readOnlyTitle}
            onClick={() => {
              remove.reset();
              setConfirmDelete(true);
            }}
          >
            Delete rule
          </Button>
        )}
        <span className="flex-1" />
        <Button variant="ghost" onClick={cancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={save}
          loading={saving}
          disabled={disabled || (!isNew && !dirty) || atRuleLimit}
          title={readOnlyTitle ?? (atRuleLimit ? 'Your plan’s rule limit is reached' : undefined)}
        >
          Save rule
        </Button>
      </div>

      {rule && (
        <ConfirmDialog
          open={confirmDelete}
          onClose={() => {
            setConfirmDelete(false);
          }}
          onConfirm={confirmRemove}
          title={`Delete ${rule.name}?`}
          description="Open incidents from this rule resolve, and it stops watching every server it matched."
          confirmLabel="Delete rule"
          pending={remove.isPending}
          error={remove.error ? errorMessage(remove.error) : undefined}
        />
      )}

      <ConfirmDialog
        open={blocker.state === 'blocked'}
        onClose={() => {
          blocker.reset?.();
        }}
        onConfirm={() => {
          blocker.proceed?.();
        }}
        tone="default"
        icon={<PencilSquareIcon className="h-5 w-5" strokeWidth={1.6} />}
        title="Discard unsaved changes?"
        description={`Your changes to ${isNew ? 'this new rule' : draft.name || 'this rule'} are not saved yet.`}
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
      />
    </section>
  );
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

interface ThresholdInputProps {
  value: string;
  unit: string;
  percent: boolean;
  invalid: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}

function ThresholdInput({ value, unit, percent, invalid, disabled, onChange }: ThresholdInputProps) {
  const id = useId();
  return (
    <span className="inline-flex items-center gap-1.5">
      <label htmlFor={id} className="sr-only">
        Threshold{unit ? ` in ${unit}` : ''}
      </label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        step="any"
        min={0}
        max={percent ? 100 : undefined}
        value={value}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className={cn(inputClasses('lg', invalid), 'num w-[84px] text-right font-semibold')}
      />
      <span className="num text-ink-muted">{unit}</span>
    </span>
  );
}

interface TimerCardProps {
  label: string;
  checked: boolean;
  disabled: boolean;
  error: string | undefined;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}

function TimerCard({ label, checked, disabled, error, onChange, children }: TimerCardProps) {
  return (
    <div className={cn(cardClasses, 'flex flex-col gap-1.5 p-3.5')}>
      <Toggle checked={checked} onChange={onChange} label={label} disabled={disabled} />
      <span className={cn(hintClasses, TOGGLE_INDENT, 'leading-7')}>{children}</span>
      {error && (
        <span className={TOGGLE_INDENT}>
          <FieldError message={error} />
        </span>
      )}
    </div>
  );
}
