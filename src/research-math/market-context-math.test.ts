import { describe, it, expect } from 'vitest';
import { buildMarketContextMath } from './market-context-math.ts';
import type { CanonicalRowV2 } from '../ports/market-history-read.port.ts';

function series(n: number, cadence: number, withTaker: boolean): CanonicalRowV2[] {
  return Array.from({ length: n }, (_, i) => ({
    schema_version: 2, minute_ts: i * cadence, symbol: 'BTCUSDT',
    open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10, turnover: (100 + i) * 10,
    oi_total_usd: 1000 + i, funding_rate: 0.0001, liq_long_usd: 1, liq_short_usd: 2,
    taker_buy_volume_usd: withTaker ? 6 : null, taker_sell_volume_usd: withTaker ? 4 : null,
    has_oi: true, has_funding: true, has_liquidations: true, has_taker_flow: withTaker,
  } as CanonicalRowV2));
}

const base = {
  symbol: 'BTCUSDT', direction: 'long' as const, regime: 'ranging' as const,
  requiredFeatures: ['oi', 'funding', 'cvd'], window: { fromMs: 0, toMs: 1 },
};

describe('buildMarketContextMath', () => {
  it('renders the micro term from dense 1m data with real CVD when taker present', () => {
    const math = buildMarketContextMath({ ...base, rows: series(120, 60_000, true) }, 1_700_000_000_000);
    const micro = math.terms.find((t) => t.config.key === 'micro');
    expect(micro).toBeDefined();
    expect(math.coverage.hasTaker).toBe(true);
    expect(micro!.rows.at(-1)!.cvd).not.toBeNull();
    expect(micro!.rows.length).toBe(micro!.config.maxRows);
  });

  it('drops sub-hour terms and marks CVD n/a for a coarse 1h, taker-less source', () => {
    const math = buildMarketContextMath({ ...base, rows: series(60, 3_600_000, false) }, 1_700_000_000_000);
    expect(math.terms.map((t) => t.config.key)).toEqual(['long']);
    expect(math.coverage.hasTaker).toBe(false);
    expect(math.terms[0]!.indicators.cvdNet).toBeNull();
    expect(math.notes.some((n) => /taker/i.test(n))).toBe(true);
  });

  it('returns zero terms with a note when there are no rows', () => {
    const math = buildMarketContextMath({ ...base, rows: [] }, 1_700_000_000_000);
    expect(math.terms).toEqual([]);
    expect(math.notes.length).toBeGreaterThan(0);
  });

  it('is deterministic for the same input + nowMs', () => {
    const rows = series(120, 60_000, true);
    const a = buildMarketContextMath({ ...base, rows }, 42);
    const b = buildMarketContextMath({ ...base, rows }, 42);
    expect(a).toEqual(b);
  });
});

describe('buildMarketContextMath Phase E indicators', () => {
  it('populates squeeze, pivots and pressure on a dense taker-bearing term', () => {
    const math = buildMarketContextMath({ ...base, rows: series(120, 60_000, true) }, 1_700_000_000_000);
    const micro = math.terms.find((t) => t.config.key === 'micro')!;
    expect(micro.indicators.squeeze).not.toBeNull();
    expect(typeof micro.indicators.squeeze!.on).toBe('boolean');
    expect(micro.indicators.pivots).not.toBeNull();
    expect(micro.indicators.pressure).not.toBeNull();
    expect(micro.indicators.pressure!.buyShare).toBeCloseTo(0.6, 9); // taker_buy 6 / (6+4)
    expect(micro.indicators.pressure!.state).toBe('buy');
  });

  it('marks pressure n/a (no taker) but keeps squeeze/pivots on a coarse OHLC term', () => {
    const math = buildMarketContextMath({ ...base, rows: series(60, 3_600_000, false) }, 1_700_000_000_000);
    const long = math.terms[0]!;
    expect(long.indicators.pressure).toBeNull();
    expect(long.indicators.pivots).not.toBeNull();
    expect(long.indicators.squeeze).not.toBeNull();
    expect(math.notes.some((n) => /Pressure/i.test(n))).toBe(true);
    expect(math.notes.some((n) => /Squeeze|Pivots/i.test(n))).toBe(true);
  });
});
