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
