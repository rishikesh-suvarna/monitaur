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
  /** card: bordered surface; plain: inside an existing card. */
  variant?: 'card' | 'plain';
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
  headingLevel: Heading = 'h3',
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 text-center',
        variant === 'card' ? 'rounded-lg border border-line bg-surface-1 p-8' : 'px-4 py-12',
        className,
      )}
    >
      <Dino mood={mood} size={dinoSize} beatTone={beatTone} label="" />
      <Heading className="m-0 text-[16px] font-semibold leading-6">{title}</Heading>
      {description && <p className="m-0 max-w-[320px] text-[13px] text-ink-muted">{description}</p>}
      {action && <div className="flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}
