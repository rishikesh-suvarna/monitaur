import { useEffect, useMemo, useRef, useState } from 'react';

import { errorMessage } from '../../api/errors';
import type { MetricKey, RuleInput, RulePreviewResponse, Severity } from '../../api/types';
import { Loader } from '../../components/Loader';
import { usePreviewRule } from '../../hooks/api/rules';
import { cn } from '../../lib/cn';
import { formatDayTime, formatDuration, toTime } from '../../lib/format';

import { formatRuleValue, PREVIEW_WINDOW_HOURS, previewCoverage, previewKey, previewSummary, previewTimeline } from './ruleModel';

/** Typing a threshold should not fire a replay per keystroke. */
export const PREVIEW_DEBOUNCE_MS = 600;
const DAYS_IN_WINDOW = 7;
const MS_PER_SECOND = 1000;

interface PreviewResult {
  key: string;
  data: RulePreviewResponse;
  /** When the replay ran, the right edge of the timeline. */
  at: number;
}

interface PreviewFailure {
  key: string;
  error: unknown;
}

export interface RulePreviewProps {
  /** The draft as an API body, or null while it has validation errors. */
  input: RuleInput | null;
  /** Why there is no input to replay, e.g. the first validation message. */
  blockedReason?: string;
  serverNames: ReadonlyMap<number, string>;
}

const SPAN_TONE: Record<Severity, string> = { warning: 'bg-warn', critical: 'bg-crit' };

/**
 * "Preview · last 7 days" (Rules.dc.html): POST /rules/preview, debounced on
 * the fields that change the replay, with a mini timeline per server.
 */
export function RulePreview({ input, blockedReason, serverNames }: RulePreviewProps) {
  const preview = usePreviewRule();
  const { mutate } = preview;
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [failure, setFailure] = useState<PreviewFailure | null>(null);
  const requested = useRef<string | null>(null);
  const key = input === null ? null : previewKey(input);

  useEffect(() => {
    if (input === null || key === null || key === requested.current) return;
    const timer = setTimeout(() => {
      requested.current = key;
      // Per-call callbacks only fire for the latest call, so a slow stale
      // replay never overwrites a newer one.
      mutate(input, {
        onSuccess: (data) => {
          setResult({ key, data, at: Date.now() });
          setFailure(null);
        },
        onError: (error) => {
          setFailure({ key, error });
        },
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [input, key, mutate]);

  const rows = useMemo(
    () => (result ? previewTimeline(result.data.incidents, result.at, serverNames, result.data.window_hours || PREVIEW_WINDOW_HOURS) : []),
    [result, serverNames],
  );

  const current = result !== null && result.key === key;
  const failed = failure !== null && failure.key === key;
  const loading = key !== null && !current && !failed;
  const metric: MetricKey = input?.metric ?? 'cpu';
  const severity: Severity = input?.severity ?? 'warning';

  let summary: string;
  if (input === null) summary = blockedReason ? `${blockedReason.replace(/\.$/, '')} to replay this rule.` : 'Fix the highlighted fields to replay this rule.';
  else if (failed) summary = `Couldn’t replay the last 7 days: ${errorMessage(failure.error)}`;
  else if (result) summary = previewSummary({ ...result.data, servers: rows.length });
  else summary = 'Replaying the last 7 days…';

  const coverage = result && current ? previewCoverage(result.data) : null;

  return (
    <section aria-label="Preview, last 7 days" className="flex flex-col gap-2 rounded-lg border border-dashed border-line-strong p-3.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[13px] font-medium text-ink">Preview · last 7 days</span>
        <span aria-live="polite" className={cn('text-[13px]', failed ? 'text-warn' : 'text-ink-muted')}>
          {summary}
        </span>
        {loading && result && <Loader size={14} label="Updating preview" className="self-center text-accent" />}
      </div>
      {coverage && <span className="text-[12px] leading-4 text-ink-faint">{coverage}</span>}
      {result && input !== null && rows.length > 0 && (
        <div className={cn('flex flex-col gap-1.5 transition-opacity duration-150', !current && 'opacity-50')}>
          {rows.map((row) => (
            <div key={row.serverId} className="grid grid-cols-[minmax(0,96px)_minmax(0,1fr)] items-center gap-3 md:grid-cols-[minmax(0,160px)_minmax(0,1fr)]">
              <span className="num truncate text-[12px] text-ink-muted" title={row.name}>
                {row.name}
              </span>
              <div
                role="img"
                aria-label={`${row.name}: ${row.spans.length === 1 ? '1 incident' : `${row.spans.length} incidents`} in the last 7 days`}
                className="relative h-4 overflow-hidden rounded-sm bg-surface-2"
              >
                {Array.from({ length: DAYS_IN_WINDOW - 1 }, (_, day) => (
                  <span
                    key={day}
                    aria-hidden="true"
                    className="absolute inset-y-0 w-px bg-line"
                    style={{ left: `${((day + 1) / DAYS_IN_WINDOW) * 100}%` }}
                  />
                ))}
                {row.spans.map((span) => (
                  <span
                    key={span.start}
                    title={spanTitle(span.start, span.end, span.peak, metric, result.at)}
                    className={cn('absolute inset-y-0.5 rounded-[2px]', SPAN_TONE[severity])}
                    style={{ left: `${span.leftPct}%`, width: `${span.widthPct}%` }}
                  />
                ))}
              </div>
            </div>
          ))}
          <div className="grid grid-cols-[minmax(0,96px)_minmax(0,1fr)] gap-3 md:grid-cols-[minmax(0,160px)_minmax(0,1fr)]">
            <span />
            <div className="num flex justify-between text-[11px] text-ink-faint">
              <span>7 days ago</span>
              <span>now</span>
            </div>
          </div>
        </div>
      )}
      {!result && loading && (
        <div aria-hidden="true" className="flex flex-col gap-1.5">
          <span className="skel h-4 w-full" />
          <span className="skel h-4 w-4/5" />
        </div>
      )}
    </section>
  );
}

function spanTitle(start: string, end: string | null, peak: number, metric: MetricKey, now: number): string {
  const startMs = toTime(start) ?? now;
  const endMs = end === null ? now : (toTime(end) ?? now);
  const length = formatDuration((endMs - startMs) / MS_PER_SECOND);
  const peakText = metric === 'heartbeat' ? '' : ` · peak ${formatRuleValue(metric, peak, 1)}`;
  return `${formatDayTime(startMs, now)} · ${end === null ? 'still open' : length}${peakText}`;
}
