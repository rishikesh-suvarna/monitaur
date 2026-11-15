import type { HTMLAttributes, Ref } from 'react';

import { cn } from '../lib/cn';

type CardElement = 'div' | 'section' | 'article' | 'aside' | 'li';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: CardElement;
  ref?: Ref<HTMLElement>;
}

/** Card: surface-1, 1 px line border, radius 8, no shadow (Tokens.dc.html). */
export const cardClasses = 'rounded-lg border border-line bg-surface-1';

export function Card({ as: Element = 'div', className, ref, ...rest }: CardProps) {
  return <Element ref={ref as Ref<never>} className={cn(cardClasses, className)} {...rest} />;
}
