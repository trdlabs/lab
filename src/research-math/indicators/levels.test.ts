import { describe, it, expect } from 'vitest';
import { swingHighLow, fibonacci, cvd, oiDelta, pctChangeOverWindow, liquidationAggregates, pivots, takerPressure } from './levels.ts';

describe('fibonacci', () => {
  it('places 0 at the high, 1 at the low, 0.5 at the midpoint', () => {
    const f = fibonacci(100, 0);
    expect(f.levels['0']).toBeCloseTo(100, 10);
    expect(f.levels['1']).toBeCloseTo(0, 10);
    expect(f.levels['0.5']).toBeCloseTo(50, 10);
  });
});

describe('swingHighLow', () => {
  it('returns the max high and min low over the trailing window', () => {
    expect(swingHighLow([1, 5, 3], [0, 2, 1], 3)).toEqual({ swingHigh: 5, swingLow: 0 });
  });
});

describe('cvd', () => {
  it('accumulates buy minus sell, null where taker missing from the start', () => {
    expect(cvd([10, 5, null], [4, 5, null])).toEqual([6, 6, 6]);
    expect(cvd([null, null], [null, null])).toEqual([null, null]);
    expect(cvd([null, 10], [null, 4])).toEqual([null, 6]);
  });
});

describe('oiDelta + pctChangeOverWindow', () => {
  it('computes per-bar delta and windowed pct change', () => {
    expect(oiDelta([100, 110, 121])).toEqual([null, 10, 11]);
    expect(pctChangeOverWindow([100, 110, 121], 2)).toBeCloseTo(21, 6);
  });
});

describe('liquidationAggregates', () => {
  it('sums sides and computes imbalance', () => {
    expect(liquidationAggregates([50, null], [30, 20])).toEqual({ longTotal: 50, shortTotal: 50, imbalance: 0 });
  });
});

describe('pivots', () => {
  it('computes classic floor pivots from a known H/L/C', () => {
    const p = pivots(110, 90, 105);
    expect(p.pp).toBeCloseTo(101.6667, 4);
    expect(p.r1).toBeCloseTo(113.3333, 4);
    expect(p.s1).toBeCloseTo(93.3333, 4);
    expect(p.r2).toBeCloseTo(121.6667, 4);
    expect(p.s2).toBeCloseTo(81.6667, 4);
    expect(p.r3).toBeCloseTo(133.3333, 4);
    expect(p.s3).toBeCloseTo(73.3333, 4);
  });

  it('orders levels S3<S2<S1<PP<R1<R2<R3 for a normal bar', () => {
    const p = pivots(110, 90, 105);
    expect(p.s3).toBeLessThan(p.s2);
    expect(p.s2).toBeLessThan(p.s1);
    expect(p.s1).toBeLessThan(p.pp);
    expect(p.pp).toBeLessThan(p.r1);
    expect(p.r1).toBeLessThan(p.r2);
    expect(p.r2).toBeLessThan(p.r3);
  });

  it('produces finite values on a degenerate H==L==C bar', () => {
    const p = pivots(100, 100, 100);
    for (const v of Object.values(p)) expect(Number.isFinite(v)).toBe(true);
    expect(p.pp).toBe(100);
  });
});

describe('takerPressure', () => {
  it('is +1 / buyShare 1 for an all-buy window', () => {
    const tp = takerPressure([10, 10, 10], [0, 0, 0], 3);
    expect(tp.bias).toBeCloseTo(1, 9);
    expect(tp.buyShare).toBeCloseTo(1, 9);
  });

  it('is −1 / buyShare 0 for an all-sell window', () => {
    const tp = takerPressure([0, 0, 0], [10, 10, 10], 3);
    expect(tp.bias).toBeCloseTo(-1, 9);
    expect(tp.buyShare).toBeCloseTo(0, 9);
  });

  it('is ~0 / buyShare 0.5 for a balanced window', () => {
    const tp = takerPressure([5, 5], [5, 5], 2);
    expect(tp.bias).toBeCloseTo(0, 9);
    expect(tp.buyShare).toBeCloseTo(0.5, 9);
  });

  it('only sums the trailing `window` bars', () => {
    // last 2 bars: buys 1+1, sells 9+9 → strongly negative; earlier bars ignored
    const tp = takerPressure([100, 100, 1, 1], [0, 0, 9, 9], 2);
    expect(tp.bias).toBeCloseTo((2 - 18) / 20, 9);
  });

  it('skips null/gap bars and returns nulls when no usable data', () => {
    expect(takerPressure([null, null], [null, null], 2)).toEqual({ bias: null, buyShare: null });
    const tp = takerPressure([null, 6], [null, 4], 2);
    expect(tp.bias).toBeCloseTo(0.2, 9);
  });

  it('returns nulls (no divide-by-zero) when totals are zero', () => {
    expect(takerPressure([0, 0], [0, 0], 2)).toEqual({ bias: null, buyShare: null });
  });

  it('returns nulls for a non-positive window (no bars summed)', () => {
    expect(takerPressure([6, 4], [4, 6], 0)).toEqual({ bias: null, buyShare: null });
    expect(takerPressure([6, 4], [4, 6], -3)).toEqual({ bias: null, buyShare: null });
  });
});
