import { PlayIcon } from '@heroicons/react/24/outline';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { Check } from '../../api/types';
import { Button } from '../../components/Button';
import { cardClasses } from '../../components/Card';
import { STRETCHED_LINK } from '../../components/serverMetrics';
import { Sparkline } from '../../components/Sparkline';
import { TickingNumber } from '../../components/TickingNumber';
import { Toggle } from '../../components/Toggle';
import { cn } from '../../lib/cn';
import { checkPath, formatLatency, formatTlsDays, latencyScaleMax, reportsTls, tlsTone, type TlsTone } from '../../lib/checks';
import { formatUptime } from '../status/statusModel';

import { TLS_TONE_CLASS } from './checkModel';

import { CheckStatusBadge, CheckTypeChip, MaintenanceChip, RunResultNote } from './CheckBits';
import type { CheckActions } from './useCheckActions';

const NBSP = ' ';

// Main.dc.html table language: status, name, then dense mono value columns.
const ROW_GRID =
  'grid grid-cols-[112px_minmax(240px,2.4fr)_56px_minmax(120px,1fr)_76px_84px_64px_164px] items-center gap-x-3 px-4';

function tlsCell(check: Check): { text: string; tone: TlsTone } {
  if (!reportsTls(check)) return { text: 'n/a', tone: 'none' };
  return { text: formatTlsDays(check.tls_days_left), tone: tlsTone(check.tls_days_left, check.tls_warn_days) };
}

function RunButton({ check, actions, touch = false }: { check: Check; actions: CheckActions; touch?: boolean }) {
  return (
    <Button
      size="sm"
      className={touch ? 'h-9' : undefined}
      leadingIcon={<PlayIcon className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />}
      loading={actions.isRunning(check.id)}
      disabled={!actions.canEdit}
      title={actions.canEdit ? undefined : actions.disabledReason}
      aria-label={`Run now: ${check.name}`}
      onClick={() => {
        actions.run(check);
      }}
    >
      Run now
    </Button>
  );
}

function EnabledToggle({ check, actions }: { check: Check; actions: CheckActions }) {
  return (
    // Above the stretched link so the switch stays clickable; the wrapper carries the viewer tooltip.
    <div className="relative z-[1]" title={actions.canEdit ? undefined : actions.disabledReason}>
      <Toggle
        hideLabel
        label={`${check.enabled ? 'Pause' : 'Resume'} ${check.name}`}
        checked={check.enabled}
        disabled={!actions.canEdit}
        onChange={(enabled) => {
          actions.setEnabled(check, enabled);
        }}
      />
    </div>
  );
}

export interface CheckListProps {
  checks: readonly Check[];
  actions: CheckActions;
  footer?: ReactNode;
}

/** Desktop table (scrolls horizontally under 1000 px): one row per check, the name links to its detail. */
export function CheckTable({ checks, actions, footer }: CheckListProps) {
  return (
    <section aria-label="Uptime checks" className={cn(cardClasses, 'overflow-hidden')}>
      <div className="overflow-x-auto">
        <div role="table" aria-label="Uptime checks" aria-rowcount={checks.length + 1} className="min-w-[1000px] text-[13px]">
          <div role="rowgroup">
            <div role="row" className={cn(ROW_GRID, 'cap h-9 border-b border-line bg-surface-2')}>
              <span role="columnheader">Status</span>
              <span role="columnheader">Check</span>
              <span role="columnheader">Type</span>
              <span role="columnheader">Latency</span>
              <span role="columnheader" className="text-right">
                Last
              </span>
              <span role="columnheader" className="text-right">
                Uptime 24h
              </span>
              <span role="columnheader" className="text-right">
                TLS
              </span>
              <span role="columnheader" className="text-right">
                <span className="sr-only">Actions</span>
              </span>
            </div>
          </div>
          <div role="rowgroup">
            {checks.map((check) => (
              <CheckRow key={check.id} check={check} actions={actions} />
            ))}
          </div>
        </div>
      </div>
      {footer && <div className="flex flex-wrap justify-between gap-4 border-t border-line px-4 py-2.5 text-[12px] text-ink-faint">{footer}</div>}
    </section>
  );
}

function CheckRow({ check, actions }: { check: Check; actions: CheckActions }) {
  const paused = !check.enabled;
  const tls = tlsCell(check);
  const result = actions.results.get(check.id);
  return (
    <>
      <div
        role="row"
        className={cn(
          ROW_GRID,
          'relative min-h-[52px] py-2 transition-colors duration-150 ease-out hover:bg-surface-2',
          result ? 'border-b-0' : 'border-b border-line',
        )}
      >
        <span role="cell">
          <CheckStatusBadge status={check.status} size="sm" />
        </span>
        <span role="cell" className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <Link to={checkPath(check.id)} title={check.name} className={cn('min-w-0 truncate font-medium text-ink hover:text-ink', STRETCHED_LINK)}>
              {check.name}
            </Link>
            {check.maintenance && <MaintenanceChip />}
          </span>
          <span className="num truncate text-[12px] text-ink-faint" title={check.target}>
            {check.target}
          </span>
        </span>
        <span role="cell">
          <CheckTypeChip type={check.type} />
        </span>
        <span role="cell" className={cn(paused && 'opacity-[0.55]')}>
          <Sparkline
            values={check.latency_spark}
            width={110}
            height={22}
            max={latencyScaleMax(check.latency_spark)}
            tone={paused ? 'off' : 'series'}
            dashed={paused}
            label={check.latency_spark.length > 1 ? `Latency of the last ${check.latency_spark.length} results` : undefined}
          />
        </span>
        <span role="cell" className={cn('text-right', paused && 'opacity-[0.55]')}>
          {/* TickingNumber lays digits out in a flex row, where a plain space would collapse. */}
          <TickingNumber value={formatLatency(check.last?.latency_ms).replace(' ', NBSP)} className="justify-end" />
        </span>
        <span role="cell" className={cn('num text-right', paused && 'opacity-[0.55]')}>
          {formatUptime(check.uptime_24h)}
        </span>
        <span role="cell" className={cn('num text-right', TLS_TONE_CLASS[tls.tone])}>
          {tls.text}
        </span>
        <span role="cell" className="relative z-[1] flex items-center justify-end gap-3">
          <RunButton check={check} actions={actions} />
          <EnabledToggle check={check} actions={actions} />
        </span>
      </div>
      {result && (
        <div role="row" className="border-b border-line px-4 pb-3">
          <span role="cell" className="block">
            <RunResultNote result={result} />
          </span>
        </div>
      )}
    </>
  );
}

/** ChecksMobile: one card per check, 44 px touch targets, the whole card opens the detail. */
export function CheckCards({ checks, actions, footer }: CheckListProps) {
  return (
    <section aria-label="Uptime checks" className="flex flex-col gap-2">
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {checks.map((check) => {
          const paused = !check.enabled;
          const tls = tlsCell(check);
          const result = actions.results.get(check.id);
          return (
            <li key={check.id} className={cn(cardClasses, 'relative flex flex-col gap-2 p-3')}>
              <div className="flex items-center gap-2">
                <CheckStatusBadge status={check.status} size="sm" />
                <Link
                  to={checkPath(check.id)}
                  title={check.name}
                  className={cn('min-w-0 flex-1 truncate text-[14px] font-semibold text-ink hover:text-ink', STRETCHED_LINK)}
                >
                  {check.name}
                </Link>
                <EnabledToggle check={check} actions={actions} />
              </div>
              <span className="num truncate text-[12px] text-ink-faint">{check.target}</span>
              <div className={cn('flex items-center gap-3', paused && 'opacity-[0.55]')}>
                <Sparkline
                  values={check.latency_spark}
                  width={64}
                  height={20}
                  max={latencyScaleMax(check.latency_spark)}
                  tone={paused ? 'off' : 'series'}
                  dashed={paused}
                />
                <span className="num flex flex-wrap gap-x-2.5 text-[12px] text-ink-muted">
                  <span>{formatLatency(check.last?.latency_ms)}</span>
                  <span>{formatUptime(check.uptime_24h)} 24h</span>
                  {tls.tone !== 'none' && <span className={TLS_TONE_CLASS[tls.tone]}>TLS {tls.text}</span>}
                </span>
              </div>
              <div className="relative z-[1] flex flex-wrap items-center gap-2">
                <CheckTypeChip type={check.type} />
                {check.maintenance && <MaintenanceChip />}
                <span className="flex-1" />
                <RunButton check={check} actions={actions} touch />
              </div>
              {result && <RunResultNote result={result} className="relative z-[1]" />}
            </li>
          );
        })}
      </ul>
      {footer && <div className="flex flex-col items-center gap-1 py-2 text-center text-[12px] text-ink-faint">{footer}</div>}
    </section>
  );
}
