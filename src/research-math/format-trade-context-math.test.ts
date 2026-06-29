import { describe, it, expect } from 'vitest';
import { buildTradeContextMath } from './trade-context-math.ts';
import { formatTradeContextMath, formatTradeContexts } from './format-trade-context-math.ts';
import type { CanonicalRowV2 } from '../ports/market-history-read.port.ts';

const MIN = 60_000;
function series(n: number, withTaker: boolean): CanonicalRowV2[] {
  return Array.from({ length: n }, (_, i) => ({
    schema_version: 2, minute_ts: i * MIN, symbol: 'PENNYUSDT',
    open: 0.05 + i * 0.0001, high: 0.05 + i * 0.0001 + 0.0002, low: 0.05 + i * 0.0001 - 0.0002,
    close: 0.05 + i * 0.0001, volume: 1000, turnover: 50,
    oi_total_usd: 1_000_000 + i, funding_rate: 0.0001, liq_long_usd: 1, liq_short_usd: 2,
    taker_buy_volume_usd: withTaker ? 6 : null, taker_sell_volume_usd: withTaker ? 4 : null,
    has_oi: true, has_funding: true, has_liquidations: true, has_taker_flow: withTaker,
  } as CanonicalRowV2));
}
const base = {
  tradeId: 'tr1', symbol: 'PENNYUSDT', direction: 'long' as const, regime: 'ranging' as const,
  requiredFeatures: ['oi'], realizedPnl: -5.5, pnlPct: -1.2, closeReason: 'stop_loss',
};

describe('formatTradeContextMath', () => {
  it('renders the header, @entry/@exit summaries, a micro table and is sub-dollar-precise', () => {
    const tc = buildTradeContextMath({ ...base, rows: series(260, true), entryMs: 200 * MIN, exitMs: 240 * MIN }, 0);
    const md = formatTradeContextMath(tc);
    expect(md).toContain('### Trade tr1 · PENNYUSDT');
    expect(md).toContain('-5.50');         // realizedPnl
    expect(md).toContain('close=stop_loss');
    expect(md).toMatch(/@entry .*Micro \(1m\):/);
    expect(md).toMatch(/@exit .*Micro \(1m\):/);
    expect(md).toContain('| ts | open | high | low | close |'); // micro table header
    // sub-dollar precision: a Pivots PP with > 2 decimals appears somewhere
    expect(md).toMatch(/Pivots PP=0\.\d{3,}/);
    expect(md).not.toMatch(/\d[eE][+-]?\d/); // no scientific notation
  });

  it('renders n/a for CVD/Pressure when the window has no taker', () => {
    const tc = buildTradeContextMath({ ...base, rows: series(260, false), entryMs: 200 * MIN, exitMs: 240 * MIN }, 0);
    const md = formatTradeContextMath(tc);
    expect(md).toContain('CVD n/a');
    expect(md).toContain('Pressure n/a');
  });
});

describe('formatTradeContexts', () => {
  it('returns empty string for no contexts and a header for ≥1', () => {
    expect(formatTradeContexts([])).toBe('');
    const tc = buildTradeContextMath({ ...base, rows: series(260, true), entryMs: 200 * MIN, exitMs: 240 * MIN }, 0);
    expect(formatTradeContexts([tc])).toContain('## Per-trade context (losing trades)');
  });
});
