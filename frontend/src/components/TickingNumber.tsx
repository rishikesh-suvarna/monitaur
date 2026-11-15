import { useEffect, useState } from 'react';

import { cn } from '../lib/cn';
import { useReducedMotion } from '../providers/MotionProvider';

export interface TickingNumberProps {
  /** Pre-formatted value, e.g. "41.6" or "94%". */
  value: string;
  className?: string;
}

/**
 * States.dc.html "Live updates": only the digits that changed move, a 400 ms
 * slide + fade. Characters are keyed from the right so the ones place keeps
 * its identity when the value grows. Tabular figures keep the width fixed.
 * Values swap instantly under reduced motion.
 */
export function TickingNumber({ value, className }: TickingNumberProps) {
  const reduced = useReducedMotion();
  // Skip the animation on first paint; only later changes tick.
  const [animate, setAnimate] = useState(false);
  useEffect(() => {
    setAnimate(true);
  }, []);

  const chars = Array.from(value);
  return (
    <span className={cn('num inline-flex', className)}>
      {chars.map((char, index) => (
        <span key={`${chars.length - index}:${char}`} className={animate && !reduced ? 'tick-in' : undefined}>
          {char}
        </span>
      ))}
    </span>
  );
}
