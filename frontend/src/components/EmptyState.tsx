import type { ReactNode } from 'react';

import { cn } from '../lib/cn';

import { Dino, type DinoBeatTone, type DinoMood } from './Dino';

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  /** Buttons or links under the text. */
  action?: ReactNode;
  mood?: DinoMood;
  beatTone?: DinoBeatTone;
  /** Dino width in px (Components.dc.html uses 160, filters 96 to 110). */
  dinoSize?: number;
  /** card: bordered surface; plain: inside an existing card (48/16 padding); inset: inside a card section (32). */
  variant?: 'card' | 'plain' | 'inset';
  /** In-list "no matches" states: 8 px gap and a 14 px title (Main and Alerts boards). */
  compact?: boolean;
  headingLevel?: 'h1' | 'h2' | 'h3';
  className?: string;
}

/** Components.dc.html EmptyState: Rex, a title, one line of context, one action. */
export function EmptyState({
  title,
  description,
  action,
  mood = 'sleep',
  beatTone = 'muted',
  dinoSize = 160,
  variant = 'card',
  compact = false,
  headingLevel: Heading = 'h3',
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-2' : 'gap-3',
        variant === 'card' && 'rounded-lg border border-line bg-surface-1 p-8',
        variant === 'plain' && 'px-4 py-12',
        variant === 'inset' && 'p-8',
        className,
      )}
    >
      <Dino mood={mood} size={dinoSize} beatTone={beatTone} label="" />
      <Heading className={cn('m-0 font-semibold', compact ? 'text-[14px] leading-5' : 'text-[16px] leading-6')}>{title}</Heading>
      {description && <p className="m-0 max-w-[300px] text-[13px] text-ink-muted">{description}</p>}
      {action && <div className="flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}
