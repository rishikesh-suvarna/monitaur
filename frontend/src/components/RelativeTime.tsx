import { useNow } from '../hooks/useNow';
import { cn } from '../lib/cn';
import { formatClock, formatRelativeTime, toTime, type DateInput } from '../lib/format';

export interface RelativeTimeProps {
  value: DateInput | null | undefined;
  /** Prefix inside the element, e.g. "updated ". */
  prefix?: string;
  className?: string;
}

/** "2s ago" that ticks every second on its own, without re-rendering parents. */
export function RelativeTime({ value, prefix = '', className }: RelativeTimeProps) {
  const now = useNow();
  const time = toTime(value);
  return (
    <time
      className={cn('num', className)}
      dateTime={time === null ? undefined : new Date(time).toISOString()}
      title={time === null ? undefined : formatClock(time)}
    >
      {prefix}
      {formatRelativeTime(value, now)}
    </time>
  );
}
