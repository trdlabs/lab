import { describe, it, expect } from 'vitest';
import { buildTradeContextMath, TRADE_TERM_CONFIGS } from './trade-context-math.ts';
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
  requiredFeatures: ['oi'], realizedPnl: -5, pnlPct: -1.2, closeReason: 'stop_loss',
};

describe('TRADE_TERM_CONFIGS', () => {
  it('is micro + short only', () => {
    expect(TRADE_TERM_CONFIGS.map((t) => t.key)).toEqual(['micro', 'short']);
  });
});

describe('buildTradeContextMath', () => {
  it('snapshots indicators at the entry bar and at the exit bar (entry close ≠ exit close)', () => {
    const rows = series(260, true); // 1m
    const entryMs = 200 * MIN, exitMs = 240 * MIN;
    const tc = buildTradeContextMath({ ...base, rows, entryMs, exitMs }, 1_700_000_000_000);
    const entMicro = tc.atEntry.find((t) => t.config.key === 'micro')!;
    const exMicro = tc.atExit.find((t) => t.config.key === 'micro')!;
    expect(entMicro).toBeDefined();
    expect(exMicro).toBeDefined();
    expect(entMicro.indicators.close).toBeCloseTo(rows[200]!.close, 9); // snapshot AS OF entry bar
    expect(exMicro.indicators.close).toBeCloseTo(rows[240]!.close, 9);   // snapshot AS OF exit bar
  });

  it('returns the last micro rows through exit as microRows (default 10)', () => {
    const rows = series(260, true);
    const tc = buildTradeContextMath({ ...base, rows, entryMs: 200 * MIN, exitMs: 240 * MIN }, 0);
    expect(tc.microRows.length).toBe(10);
    expect(tc.microRows.at(-1)!.tsMs).toBe(240 * MIN); // last bar at/through exit
  });

  it('drops a term unavailable at entry for insufficient warmup, with a note', () => {
    // entry at bar 140 → short(5m) has ~28 bars before entry (< minBars 30) → absent@entry; present@exit (260 → ~52)
    const rows = series(260, true);
    const tc = buildTradeContextMath({ ...base, rows, entryMs: 140 * MIN, exitMs: 259 * MIN }, 0);
    expect(tc.atEntry.some((t) => t.config.key === 'short')).toBe(false);
    expect(tc.atExit.some((t) => t.config.key === 'short')).toBe(true);
    expect(tc.notes.some((n) => /warmup/i.test(n) && /Short/i.test(n))).toBe(true);
  });

  it('marks CVD/Pressure n/a when the window has no taker flow', () => {
    const rows = series(260, false);
    const tc = buildTradeContextMath({ ...base, rows, entryMs: 200 * MIN, exitMs: 240 * MIN }, 0);
    const exMicro = tc.atExit.find((t) => t.config.key === 'micro')!;
    expect(exMicro.indicators.cvdNet).toBeNull();
    expect(exMicro.indicators.pressure).toBeNull();
  });

  it('handles empty rows without throwing (empty terms + a note)', () => {
    const tc = buildTradeContextMath({ ...base, rows: [], entryMs: 0, exitMs: MIN }, 0);
    expect(tc.atEntry).toEqual([]);
    expect(tc.atExit).toEqual([]);
    expect(tc.microRows).toEqual([]);
    expect(tc.notes.length).toBeGreaterThan(0);
  });

  it('is deterministic for the same input + nowMs', () => {
    const rows = series(260, true);
    const a = buildTradeContextMath({ ...base, rows, entryMs: 200 * MIN, exitMs: 240 * MIN }, 42);
    const b = buildTradeContextMath({ ...base, rows, entryMs: 200 * MIN, exitMs: 240 * MIN }, 42);
    expect(a).toEqual(b);
  });
});
