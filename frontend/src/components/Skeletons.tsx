import type { CSSProperties } from 'react';

import { cn } from '../lib/cn';

export interface SkeletonProps {
  className?: string;
  style?: CSSProperties;
  /** Fully round (status dots). */
  round?: boolean;
}

/** A shimmering block (slow opacity pulse; still under reduced motion). */
export function Skeleton({ className, style, round = false }: SkeletonProps) {
  return <span aria-hidden="true" className={cn('skel', round && 'rounded-full', className)} style={style} />;
}

const ROW_WIDTHS = ['62%', '48%', '70%', '40%', '56%', '66%'];

/**
 * States.dc.html loading: five tiles and six table rows that keep the real
 * layout, so nothing jumps when data lands.
 */
export function ServerListSkeleton({ rows = ROW_WIDTHS.length, tiles = 5, className }: { rows?: number; tiles?: number; className?: string }) {
  return (
    <div aria-busy="true" aria-label="Loading servers" className={cn('flex flex-col gap-3.5 rounded-lg border border-line bg-surface-1 p-4', className)}>
      {tiles > 0 && (
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${tiles}, minmax(0, 1fr))` }}>
          {Array.from({ length: tiles }, (_, index) => (
            <div key={index} className="flex h-14 flex-col gap-2 rounded-lg border border-line p-2.5">
              <Skeleton className="h-2 w-1/2" />
              <Skeleton className="h-3.5 w-[30%]" />
            </div>
          ))}
        </div>
      )}
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="grid h-7 grid-cols-[20px_2fr_repeat(3,minmax(0,1fr))] items-center gap-4">
          <Skeleton round className="h-3.5 w-3.5" />
          <Skeleton className="h-2.5" style={{ width: ROW_WIDTHS[index % ROW_WIDTHS.length] }} />
          <Skeleton className="h-2.5" />
          <Skeleton className="h-2.5" />
          <Skeleton className="h-2.5" />
        </div>
      ))}
    </div>
  );
}

/** Rows only, for inside an existing card (table body while loading). */
export function TableRowsSkeleton({ rows = ROW_WIDTHS.length }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="flex flex-col gap-3.5 p-4">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="grid h-7 grid-cols-[20px_2fr_repeat(3,minmax(0,1fr))] items-center gap-4">
          <Skeleton round className="h-3.5 w-3.5" />
          <Skeleton className="h-2.5" style={{ width: ROW_WIDTHS[index % ROW_WIDTHS.length] }} />
          <Skeleton className="h-2.5" />
          <Skeleton className="h-2.5" />
          <Skeleton className="h-2.5" />
        </div>
      ))}
    </div>
  );
}

/** A card-shaped placeholder (incident rail, metric cards). */
export function CardSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={cn('flex flex-col gap-2.5 rounded-lg border border-line bg-surface-1 px-3.5 py-3', className)}>
      <Skeleton className="h-4 w-20 rounded-full" />
      {Array.from({ length: lines - 1 }, (_, index) => (
        <Skeleton key={index} className="h-2.5" style={{ width: ROW_WIDTHS[(index + 2) % ROW_WIDTHS.length] }} />
      ))}
    </div>
  );
}
