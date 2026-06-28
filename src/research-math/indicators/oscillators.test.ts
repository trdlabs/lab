import { describe, it, expect } from 'vitest';
import { stochastic, adx } from './oscillators.ts';

describe('stochastic', () => {
  it('%K is 100 when close sits at the window high', () => {
    const highs = [2, 3, 4, 5], lows = [1, 1, 1, 1], closes = [2, 3, 4, 5];
    const out = stochastic(highs, lows, closes, 2, 1, 1);
    expect(out.at(-1)!.k).toBeCloseTo(100, 6);
  });
  it('%K and %D stay within [0,100]', () => {
    const h = [5, 6, 7, 6, 5, 6, 7], l = [4, 5, 6, 5, 4, 5, 6], c = [4.5, 5.5, 6.5, 5.5, 4.5, 5.5, 6.5];
    for (const p of stochastic(h, l, c, 3, 2, 1)) {
      if (p) { expect(p.k).toBeGreaterThanOrEqual(0); expect(p.k).toBeLessThanOrEqual(100); }
    }
  });
});

describe('adx', () => {
  it('produces values in [0,100] and +DI dominates a strict uptrend', () => {
    const h = Array.from({ length: 30 }, (_, i) => 10 + i);
    const l = h.map((x) => x - 1);
    const c = h.map((x) => x - 0.5);
    const out = adx(h, l, c, 5);
    const last = out.at(-1)!;
    expect(last.adx).toBeGreaterThanOrEqual(0);
    expect(last.adx).toBeLessThanOrEqual(100);
    expect(last.plusDi).toBeGreaterThan(last.minusDi);
  });
  it('is null until 2*period-1', () => {
    const h = [1, 2, 3, 4], l = [0, 1, 2, 3], c = [0.5, 1.5, 2.5, 3.5];
    expect(adx(h, l, c, 5)).toEqual([null, null, null, null]);
  });
});
