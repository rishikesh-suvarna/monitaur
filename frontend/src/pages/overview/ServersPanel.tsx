import { Bars3Icon, MagnifyingGlassIcon, Squares2X2Icon } from '@heroicons/react/24/outline';

import type { ServerSummary } from '../../api/types';
import { Button } from '../../components/Button';
import { ChipButton } from '../../components/Chip';
import { EmptyState } from '../../components/EmptyState';
import { Input } from '../../components/Input';
import { SegmentedControl } from '../../components/SegmentedControl';
import { Select } from '../../components/Select';
import { ServerCard } from '../../components/ServerCard';
import { ServerTable } from '../../components/ServerRow';
import { SORT_KEYS, SORT_LABELS, type SortKey } from '../../lib/fleet';
import type { MetricBreaches } from '../../lib/status';

export type OverviewView = 'table' | 'grid';

const MOBILE_SORT_LABELS: Record<SortKey, string> = {
  status: 'Worst first',
  name: 'Name',
  cpu: 'CPU',
  mem: 'Memory',
  disk: 'Disk',
};

export interface ServersPanelProps {
  servers: readonly ServerSummary[];
  total: number;
  breaches: ReadonlyMap<number, MetricBreaches>;
  tags: readonly string[];
  query: string;
  onQuery: (query: string) => void;
  tag: string | null;
  onTag: (tag: string | null) => void;
  sort: SortKey;
  onSort: (sort: SortKey) => void;
  view: OverviewView;
  onView: (view: OverviewView) => void;
  onClearFilters: () => void;
  live: boolean;
  compact: boolean;
}

function NoMatches({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <EmptyState
      variant="plain"
      compact
      mood="lost"
      dinoSize={96}
      title={query.trim() === '' ? 'No servers match these filters' : `No servers match “${query.trim()}”`}
      action={
        <Button size="sm" onClick={onClear}>
          Clear filters
        </Button>
      }
    />
  );
}

function TagChips({ tags, tag, onTag, size }: { tags: readonly string[]; tag: string | null; onTag: (tag: string | null) => void; size: 'md' | 'lg' }) {
  if (tags.length === 0) return null;
  return (
    <>
      <ChipButton
        size={size}
        pressed={tag === null}
        onClick={() => {
          onTag(null);
        }}
      >
        {size === 'md' ? 'All tags' : 'All'}
      </ChipButton>
      {tags.map((item) => (
        <ChipButton
          key={item}
          size={size}
          pressed={tag === item}
          onClick={() => {
            onTag(tag === item ? null : item);
          }}
        >
          {item}
        </ChipButton>
      ))}
    </>
  );
}

/** Main.dc.html servers card (toolbar, table or grid, footer) and the mobile list. */
export function ServersPanel(props: ServersPanelProps) {
  const { servers, total, breaches, tags, query, onQuery, tag, onTag, sort, onSort, view, onView, onClearFilters, live, compact } = props;
  const countLine = (
    <>
      Showing <span className="num">{servers.length}</span> of <span className="num">{total}</span>
    </>
  );

  if (compact) {
    return (
      <section aria-labelledby="servers-heading" className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h2 id="servers-heading" className="m-0 flex-1 text-[15px] font-semibold">
            Servers
          </h2>
          <Select
            label="Sort"
            hideLabel
            value={sort}
            onChange={onSort}
            options={SORT_KEYS.map((key) => ({ value: key, label: MOBILE_SORT_LABELS[key] }))}
            size="md"
          />
        </div>
        {tags.length > 0 && (
          <div role="group" aria-label="Filter by tag" className="no-scrollbar flex gap-1.5 overflow-x-auto pb-0.5">
            <TagChips tags={tags} tag={tag} onTag={onTag} size="lg" />
          </div>
        )}
        {servers.length === 0 ? (
          <NoMatches query={query} onClear={onClearFilters} />
        ) : (
          servers.map((server) => (
            <ServerCard key={server.id} server={server} variant="compact" {...(breaches.has(server.id) ? { breaches: breaches.get(server.id) } : {})} />
          ))
        )}
        <span className="py-2 text-center text-[12px] text-ink-faint">{countLine}</span>
      </section>
    );
  }

  return (
    <section aria-label="Servers" className="min-w-0 flex-[999_1_640px] overflow-hidden rounded-lg border border-line bg-surface-1">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <Input
          label="Search servers"
          hideLabel
          placeholder="Filter by name…"
          value={query}
          onChange={(event) => {
            onQuery(event.target.value);
          }}
          leading={<MagnifyingGlassIcon className="h-4 w-4" strokeWidth={1.8} />}
          type="search"
          fieldClassName="flex-[1_1_220px] max-w-[320px]"
        />
        {tags.length > 0 && (
          <div role="group" aria-label="Filter by tag" className="flex flex-wrap gap-1.5">
            <TagChips tags={tags} tag={tag} onTag={onTag} size="md" />
          </div>
        )}
        <div className="flex-1" />
        <Select
          label="Sort"
          inlineLabel
          value={sort}
          onChange={onSort}
          options={SORT_KEYS.map((key) => ({ value: key, label: SORT_LABELS[key] }))}
          size="sm"
        />
        <SegmentedControl<OverviewView>
          aria-label="Layout"
          value={view}
          onChange={onView}
          options={[
            { value: 'table', label: 'Table', icon: <Bars3Icon className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" /> },
            { value: 'grid', label: 'Grid', icon: <Squares2X2Icon className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" /> },
          ]}
        />
      </div>

      {servers.length === 0 ? (
        <NoMatches query={query} onClear={onClearFilters} />
      ) : view === 'table' ? (
        <ServerTable servers={servers} breaches={breaches} />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-3 p-4">
          {servers.map((server) => (
            <ServerCard key={server.id} server={server} {...(breaches.has(server.id) ? { breaches: breaches.get(server.id) } : {})} />
          ))}
        </div>
      )}

      <div className="flex justify-between gap-4 px-4 py-2.5 text-[12px] text-ink-faint">
        <span>{countLine}</span>
        {live && <span>Live values tick every 3 s</span>}
      </div>
    </section>
  );
}
