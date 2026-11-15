import { Combobox, ComboboxInput, ComboboxOption, ComboboxOptions } from '@headlessui/react';
import { TagIcon } from '@heroicons/react/24/outline';
import { useMemo, useState, type KeyboardEvent } from 'react';

import type { ServerSummary } from '../../api/types';
import { StatusIcon } from '../../components/StatusBadge';
import { cn } from '../../lib/cn';
import { collectTags } from '../../lib/fleet';
import { normalizeTag } from '../../lib/names';

type ScopeOption = { kind: 'server'; id: number; name: string; server: ServerSummary } | { kind: 'tag'; tag: string; count: number; isNew: boolean };

const MAX_OPTIONS = 30;

export interface ScopePickerProps {
  servers: readonly ServerSummary[];
  serverIds: readonly number[];
  tags: readonly string[];
  onChange: (next: { serverIds: number[]; tags: string[] }) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}

const CHIP = 'inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-sm border border-line bg-surface-2 px-[7px] text-[12px] font-medium text-ink-muted';

/**
 * "Specific servers or tags": chips in an input well (Rules.dc.html), with a
 * combobox over the org's servers and the union of their tags. A typed tag no
 * server has yet is allowed, so future servers can match it.
 */
export function ScopePicker({ servers, serverIds, tags, onChange, disabled = false, invalid = false, describedBy }: ScopePickerProps) {
  const [query, setQuery] = useState('');
  const byId = useMemo(() => new Map(servers.map((server) => [server.id, server])), [servers]);
  const allTags = useMemo(() => collectTags([...servers]), [servers]);

  const options = useMemo<ScopeOption[]>(() => {
    const text = query.trim().toLowerCase();
    const tagCounts = new Map(allTags.map((tag) => [tag, servers.filter((server) => server.tags.includes(tag)).length]));
    const tagOptions: ScopeOption[] = allTags
      .filter((tag) => !tags.includes(tag) && (text === '' || tag.includes(text)))
      .map((tag) => ({ kind: 'tag', tag, count: tagCounts.get(tag) ?? 0, isNew: false }));
    const serverOptions: ScopeOption[] = servers
      .filter((server) => !serverIds.includes(server.id) && (text === '' || server.name.toLowerCase().includes(text)))
      .map((server) => ({ kind: 'server', id: server.id, name: server.name, server }));
    const typed = normalizeTag(query);
    const offerNew = typed !== '' && !allTags.includes(typed) && !tags.includes(typed);
    const created: ScopeOption[] = offerNew ? [{ kind: 'tag', tag: typed, count: 0, isNew: true }] : [];
    return [...tagOptions, ...serverOptions, ...created].slice(0, MAX_OPTIONS);
  }, [allTags, query, serverIds, servers, tags]);

  const pick = (option: ScopeOption | null): void => {
    if (!option) return;
    setQuery('');
    if (option.kind === 'tag') onChange({ serverIds: [...serverIds], tags: [...tags, option.tag] });
    else onChange({ serverIds: [...serverIds, option.id], tags: [...tags] });
  };

  const removeTag = (tag: string): void => {
    onChange({ serverIds: [...serverIds], tags: tags.filter((item) => item !== tag) });
  };
  const removeServer = (id: number): void => {
    onChange({ serverIds: serverIds.filter((item) => item !== id), tags: [...tags] });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Backspace' || query !== '') return;
    const lastServer = serverIds[serverIds.length - 1];
    if (lastServer !== undefined) removeServer(lastServer);
    else {
      const lastTag = tags[tags.length - 1];
      if (lastTag !== undefined) removeTag(lastTag);
    }
  };

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-1.5 rounded border bg-bg p-2',
        'focus-within:border-accent focus-within:shadow-[0_0_0_3px_rgb(var(--ac-soft))]',
        invalid ? 'border-crit' : 'border-line-strong',
        disabled && 'opacity-60',
      )}
    >
      {tags.map((tag) => (
        <span key={`t:${tag}`} className={CHIP}>
          tag: {tag}
          <RemoveButton label={`Remove tag ${tag}`} disabled={disabled} onClick={() => removeTag(tag)} />
        </span>
      ))}
      {serverIds.map((id) => {
        const name = byId.get(id)?.name ?? `server #${id}`;
        return (
          <span key={`s:${id}`} className={cn(CHIP, 'num')}>
            {name}
            <RemoveButton label={`Remove ${name}`} disabled={disabled} onClick={() => removeServer(id)} />
          </span>
        );
      })}
      <Combobox<ScopeOption | null> value={null} onChange={pick} onClose={() => setQuery('')} disabled={disabled} immediate>
        <ComboboxInput
          aria-label="Add server or tag"
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          placeholder="Add server or tag…"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={onKeyDown}
          className="min-w-[120px] flex-1 border-0 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint focus-visible:outline-none"
        />
        <ComboboxOptions
          anchor={{ to: 'bottom start', gap: 6 }}
          className="z-50 max-h-72 w-[var(--input-width)] min-w-[260px] overflow-auto rounded-lg border border-line-strong bg-surface-1 p-1 shadow-float empty:invisible focus:outline-none"
        >
          {options.length === 0 ? (
            <div className="px-2 py-2 text-[13px] text-ink-faint">{query === '' ? 'Every server and tag is already picked.' : 'No servers or tags match.'}</div>
          ) : (
            options.map((option) => (
              <ComboboxOption
                key={option.kind === 'tag' ? `t:${option.tag}` : `s:${option.id}`}
                value={option}
                className="flex h-8 cursor-pointer items-center gap-2 rounded-sm px-2 text-[13px] text-ink-muted data-[focus]:bg-surface-3 data-[focus]:text-ink"
              >
                {option.kind === 'tag' ? (
                  <>
                    <TagIcon className="h-3.5 w-3.5 flex-none text-ink-faint" strokeWidth={1.8} aria-hidden="true" />
                    <span className="flex-1 truncate">
                      {option.isNew ? 'Add tag ' : 'tag: '}
                      <span className="text-ink">{option.tag}</span>
                    </span>
                    <span className="num text-[12px] text-ink-faint">{option.isNew ? 'no servers yet' : option.count}</span>
                  </>
                ) : (
                  <>
                    <StatusIcon status={option.server.status} size={12} className="text-ink-faint" />
                    <span className="num flex-1 truncate">{option.name}</span>
                  </>
                )}
              </ComboboxOption>
            ))
          )}
        </ComboboxOptions>
      </Combobox>
    </div>
  );
}

function RemoveButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="cursor-pointer border-0 bg-transparent p-0 text-[14px] leading-none text-ink-faint hover:text-ink disabled:cursor-not-allowed"
    >
      ×
    </button>
  );
}
