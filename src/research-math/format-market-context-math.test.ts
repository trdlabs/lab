import { describe, it, expect } from 'vitest';
import { buildMarketContextMath } from './market-context-math.ts';
import { formatMarketContextMath } from './format-market-context-math.ts';
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
  requiredFeatures: ['oi', 'funding', 'cvd'], window: { fromMs: 0, toMs: 7_200_000 },
};

describe('formatMarketContextMath', () => {
  it('emits a header, the required features, a coverage line and one section per term', () => {
    const md = formatMarketContextMath(buildMarketContextMath({ ...base, rows: series(120, 60_000, true) }, 0));
    expect(md).toContain('## Market Context: BTCUSDT');
    expect(md).toContain('bias: long');
    expect(md).toContain('Required features: oi, funding, cvd');
    expect(md).toContain('### Micro (1m)');
    expect(md).toMatch(/\| ts \|/);
  });

  it('renders n/a for CVD and a Notes block when taker is absent', () => {
    const md = formatMarketContextMath(buildMarketContextMath({ ...base, rows: series(60, 3_600_000, false) }, 0));
    expect(md).toContain('### Long (1h)');
    expect(md.toLowerCase()).toContain('n/a');
    expect(md).toContain('> Notes:');
  });

  it('is deterministic', () => {
    const rows = series(120, 60_000, true);
    expect(formatMarketContextMath(buildMarketContextMath({ ...base, rows }, 0)))
      .toEqual(formatMarketContextMath(buildMarketContextMath({ ...base, rows }, 0)));
  });
});

describe('formatMarketContextMath Phase E summary parts', () => {
  it('renders Squeeze, Pivots and Pressure in the summary when data supports them', () => {
    const md = formatMarketContextMath(buildMarketContextMath({ ...base, rows: series(120, 60_000, true) }, 0));
    expect(md).toMatch(/Squeeze (ON|OFF)/);
    expect(md).toContain('Pivots PP=');
    expect(md).toMatch(/Pressure [+-]?\d/);
    expect(md).toContain('% buy)');
  });

  it('renders Pressure n/a (no taker) while still showing Squeeze/Pivots', () => {
    const md = formatMarketContextMath(buildMarketContextMath({ ...base, rows: series(60, 3_600_000, false) }, 0));
    expect(md).toContain('Pressure n/a');
    expect(md).toMatch(/Squeeze (ON|OFF)/);
    expect(md).toContain('Pivots PP=');
  });
});

describe('formatMarketContextMath price precision (sub-dollar instruments)', () => {
  // A ~$0.05 instrument: with fixed-2-decimal rounding every price field collapses to 0.05/0.00.
  function pennyRows(n: number, cadence: number): CanonicalRowV2[] {
    return Array.from({ length: n }, (_, i) => {
      const px = 0.05 + (i % 7) * 0.0001; // small, sub-dollar, varying in the 4th–5th decimal
      return {
        schema_version: 2, minute_ts: i * cadence, symbol: 'PENNYUSDT',
        open: px, high: px + 0.0002, low: px - 0.0002, close: px, volume: 1000, turnover: px * 1000,
        oi_total_usd: 1_000_000 + i, funding_rate: 0.0001, liq_long_usd: 1, liq_short_usd: 2,
        taker_buy_volume_usd: 6, taker_sell_volume_usd: 4,
        has_oi: true, has_funding: true, has_liquidations: true, has_taker_flow: true,
      } as CanonicalRowV2;
    });
  }

  it('renders sub-dollar price fields with more than 2 decimals (not collapsed to 0.05/0.00)', () => {
    const md = formatMarketContextMath(buildMarketContextMath({ ...base, rows: pennyRows(120, 60_000) }, 0));
    // Pivots PP must carry >2 decimals for a ~0.05 instrument (e.g. 0.0500x), not a bare "0.05".
    const pivotMatch = md.match(/Pivots PP=([0-9.]+)/);
    expect(pivotMatch).not.toBeNull();
    const decimals = pivotMatch![1]!.split('.')[1]?.length ?? 0;
    expect(decimals).toBeGreaterThan(2);
    // No scientific notation anywhere in the block.
    expect(md).not.toMatch(/\d[eE][+-]?\d/);
  });

  it('keeps the per-row table columns byte-unchanged (only cell precision changes)', () => {
    const md = formatMarketContextMath(buildMarketContextMath({ ...base, rows: pennyRows(120, 60_000) }, 0));
    expect(md).toContain('| ts | open | high | low | close | vol | ema9 | ema21 | rsi14 | atr14 | oi | oiΔ | cvd | liqL | liqS |');
  });
});

describe('formatMarketContextMath price precision (high-priced instruments)', () => {
  function richRows(n: number, cadence: number): CanonicalRowV2[] {
    return Array.from({ length: n }, (_, i) => {
      const px = 42000 + i; // five-figure price
      return {
        schema_version: 2, minute_ts: i * cadence, symbol: 'BTCUSDT',
        open: px, high: px + 5, low: px - 5, close: px, volume: 10, turnover: px * 10,
        oi_total_usd: 1000 + i, funding_rate: 0.0001, liq_long_usd: 1, liq_short_usd: 2,
        taker_buy_volume_usd: 6, taker_sell_volume_usd: 4,
        has_oi: true, has_funding: true, has_liquidations: true, has_taker_flow: true,
      } as CanonicalRowV2;
    });
  }

  it('keeps high prices at 2 decimals (no trailing-zero noise beyond 2 dp)', () => {
    const md = formatMarketContextMath(buildMarketContextMath({ ...base, rows: richRows(120, 60_000) }, 0));
    const pivotMatch = md.match(/Pivots PP=([0-9.]+)/);
    expect(pivotMatch).not.toBeNull();
    expect(pivotMatch![1]!.split('.')[1]?.length ?? 0).toBe(2);
  });
});
