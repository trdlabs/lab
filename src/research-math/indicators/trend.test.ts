import { describe, it, expect } from 'vitest';
import { ema, sma, rsi, macd } from './trend.ts';

describe('sma', () => {
  it('is null before warmup and the window mean after', () => {
    expect(sma([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
  });
});

describe('ema', () => {
  it('on a constant series equals the constant after warmup', () => {
    const out = ema([5, 5, 5, 5, 5], 3);
    expect(out.slice(0, 2)).toEqual([null, null]);
    for (const v of out.slice(2)) expect(v).toBeCloseTo(5, 10);
  });
  it('seeds with the SMA of the first `period` values', () => {
    expect(ema([2, 4, 6], 3)![2]).toBeCloseTo(4, 10); // seed = mean(2,4,6)
  });
});

describe('rsi', () => {
  it('is 100 for a strictly rising series and 0 for a strictly falling one', () => {
    expect(rsi([1, 2, 3, 4, 5], 2).at(-1)).toBe(100);
    expect(rsi([5, 4, 3, 2, 1], 2).at(-1)).toBe(0);
  });
  it('is null during warmup', () => {
    expect(rsi([1, 2, 3], 2)[1]).toBeNull(); // first value at index = period
  });
});

describe('macd', () => {
  it('line is null during warmup, positive on a rising series, and hist = line - signal', () => {
    const out = macd([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 2, 4, 2);
    const last = out.at(-1)!;
    expect(out[0]).toBeNull(); // warmup: macd line undefined until both EMAs warm up
    expect(last).not.toBeNull();
    expect(last.line).toBeGreaterThan(0); // rising series: faster EMA(2) tracks higher recent values than EMA(4), so the macd line is positive
    expect(last.hist).toBeCloseTo(last.line - last.signal, 10);
  });
});
