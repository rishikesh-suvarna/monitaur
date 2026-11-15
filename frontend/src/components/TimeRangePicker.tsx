import type { SeriesRange } from '../api/types';

import { LiveDot } from './LiveDot';
import { SegmentedControl, type SegmentOption } from './SegmentedControl';

import { RANGE_LABELS, TIME_RANGES } from '../lib/ranges';

export interface TimeRangePickerProps {
  value: SeriesRange;
  onChange: (range: SeriesRange) => void;
  size?: 'md' | 'touch';
  className?: string;
}

/** Components.dc.html TimeRangePicker: Live (with a pulsing dot) to 30d. */
export function TimeRangePicker({ value, onChange, size = 'md', className }: TimeRangePickerProps) {
  const options: SegmentOption<SeriesRange>[] = TIME_RANGES.map((range) => ({
    value: range,
    label: RANGE_LABELS[range],
    ...(range === 'live' ? { icon: <LiveDot size={8} tone="ok" /> } : {}),
  }));
  return (
    <SegmentedControl
      aria-label="Time range"
      value={value}
      onChange={onChange}
      options={options}
      size={size}
      {...(className === undefined ? {} : { className })}
    />
  );
}
