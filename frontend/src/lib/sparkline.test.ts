import { describe, expect, it } from 'vitest';

import { isOneStepShift, sparkAreaPath, sparkLinePath } from './sparkline';

const geometry = { width: 64, height: 20, min: 0, max: 100 };

describe('sparkline paths', () => {
  it('maps values onto the viewBox, top = max', () => {
    expect(sparkLinePath([0, 50, 100], geometry)).toBe('M0.0 20.0 L32.0 10.0 L64.0 0.0');
  });

  it('breaks the line at gaps instead of interpolating', () => {
    expect(sparkLinePath([10, null, 30, 40], geometry)).toBe('M0.0 18.0 M42.7 14.0 L64.0 12.0');
  });

  it('closes each run of the area to the baseline and skips single points', () => {
    expect(sparkAreaPath([10, null, 30, 40], geometry)).toBe('M42.7 14.0 L64.0 12.0 L64.0 20.0 L42.7 20.0 Z');
  });

  it('clamps values outside the scale', () => {
    expect(sparkLinePath([-5, 150], geometry)).toBe('M0.0 20.0 L64.0 0.0');
  });
});

describe('isOneStepShift', () => {
  it('detects a series advanced by one bucket (last two may change)', () => {
    expect(isOneStepShift([1, 2, 3, 4, 5], [2, 3, 4, 5.5, 6])).toBe(true);
  });

  it('rejects unrelated or differently sized series', () => {
    expect(isOneStepShift([1, 2, 3, 4, 5], [9, 9, 9, 9, 9])).toBe(false);
    expect(isOneStepShift([1, 2, 3], [2, 3, 4, 5])).toBe(false);
  });
});
