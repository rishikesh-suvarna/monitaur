import { describe, expect, it } from 'vitest';

import { isUnlimited, usageLabel, usageState } from './usage';

describe('usageState', () => {
  it('treats a limit of 0 as unlimited, never full', () => {
    expect(usageState(12, 0)).toEqual({
      used: 12,
      limit: null,
      ratio: 0,
      percent: 0,
      tone: 'normal',
      remaining: null,
      atLimit: false,
      label: '12 · no limit',
    });
    expect(isUnlimited(0)).toBe(true);
  });

  it('reports share, remaining slots and a normal tone below 80%', () => {
    expect(usageState(1, 3)).toMatchObject({ limit: 3, percent: 33, tone: 'normal', remaining: 2, atLimit: false, label: '1 of 3' });
  });

  it('turns near at 80% and full at the limit', () => {
    expect(usageState(7, 10).tone).toBe('normal');
    expect(usageState(8, 10).tone).toBe('near');
    expect(usageState(10, 10)).toMatchObject({ tone: 'full', atLimit: true, remaining: 0, percent: 100 });
  });

  it('clamps usage over the limit (a plan downgraded under existing data)', () => {
    expect(usageState(5, 3)).toMatchObject({ ratio: 1, percent: 100, remaining: 0, atLimit: true, label: '5 of 3' });
  });

  it('sanitises bad input instead of drawing NaN widths', () => {
    expect(usageState(Number.NaN, 10)).toMatchObject({ used: 0, percent: 0 });
    expect(usageState(-4, 10).used).toBe(0);
    expect(usageLabel(2.7, 5)).toBe('2 of 5');
  });
});
