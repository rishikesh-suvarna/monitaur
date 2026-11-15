import { cn } from '../lib/cn';

/** The Watcher mark: an eye (circle with a vertical almond pupil cut out). */
export const WATCHER_OUTER_PATH = 'M4 24a20 20 0 1 0 40 0a20 20 0 1 0 -40 0Z';
export const WATCHER_PUPIL_PATH = 'M24 8.5C29.5 15 29.5 33 24 39.5C18.5 33 18.5 15 24 8.5Z';

const WORDMARK_SCALE = 0.7;
const GAP_SCALE = 0.3;

export interface LogoProps {
  /** Mark size in px (Logo.dc.html default 28). */
  size?: number;
  /** Show the "Monitaur" wordmark beside the mark. */
  wordmark?: boolean;
  className?: string;
}

/** Logo.dc.html: the Watcher mark in the accent colour, optional wordmark. */
export function Logo({ size = 28, wordmark = true, className }: LogoProps) {
  return (
    <span
      className={cn('inline-flex items-center leading-none text-ink', className)}
      style={{ gap: Math.round(size * GAP_SCALE) }}
    >
      <svg
        viewBox="0 0 48 48"
        width={size}
        height={size}
        role="img"
        aria-label="Monitaur"
        className="flex-none"
      >
        <path className="fill-accent" fillRule="evenodd" d={`${WATCHER_OUTER_PATH}${WATCHER_PUPIL_PATH}`} />
      </svg>
      {wordmark && (
        <span
          aria-hidden="true"
          className="font-semibold tracking-[-0.02em]"
          style={{ fontSize: Math.round(size * WORDMARK_SCALE) }}
        >
          Monitaur
        </span>
      )}
    </span>
  );
}
