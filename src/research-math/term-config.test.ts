import { describe, it, expect } from 'vitest';
import { TERM_CONFIGS, inferCadenceMs, isTermIncluded } from './term-config.ts';
import type { CanonicalRowV2 } from '../ports/market-history-read.port.ts';

const at = (ts: number) => ({ minute_ts: ts } as CanonicalRowV2);

describe('inferCadenceMs', () => {
  it('returns the smallest gap between timestamps', () => {
    expect(inferCadenceMs([at(0), at(60_000), at(120_000)])).toBe(60_000);
    expect(inferCadenceMs([at(0), at(3_600_000)])).toBe(3_600_000);
    expect(inferCadenceMs([])).toBeNull();
  });
});

describe('isTermIncluded', () => {
  it('includes a term only if cadence ≤ tf and enough bars', () => {
    const micro = TERM_CONFIGS.find((t) => t.key === 'micro')!;
    expect(isTermIncluded(60_000, micro.minBars, micro)).toBe(true);
    expect(isTermIncluded(3_600_000, 9999, micro)).toBe(false); // cadence 1h can't make 1m
    expect(isTermIncluded(60_000, micro.minBars - 1, micro)).toBe(false); // too few bars
  });
});

describe('TERM_CONFIGS Phase E fields', () => {
  it('every config has a Keltner multiplier and a pressure window', () => {
    for (const c of TERM_CONFIGS) {
      expect(c.kcMult).toBe(1.5);
      expect(c.pressureWindow).toBeGreaterThan(0);
    }
  });
});
