import { describe, it, expect } from 'vitest';
import { evaluateTradePreservation, DEFAULT_PRESERVATION_THRESHOLDS } from './trade-preservation.ts';
import type { PreservationAggregates } from './trade-preservation.ts';
import type { TradeRecord } from '../domain/research-experiment.ts';

const T = DEFAULT_PRESERVATION_THRESHOLDS;
function tr(over: Partial<TradeRecord> = {}): TradeRecord {
  return { entryTs: 1000, exitTs: 2000, side: 'long', realizedPnl: 10, ...over };
}
function agg(bPnl: number, bN: number, vPnl: number, vN: number): PreservationAggregates {
  return { baseline: { netPnlUsd: bPnl, totalTrades: bN }, variant: { netPnlUsd: vPnl, totalTrades: vN } };
}

describe('matching', () => {
  it('matches same-side same-entry trades; flags disappeared and new', () => {
    const base = [tr({ entryTs: 100 }), tr({ entryTs: 200 })];
    const variant = [tr({ entryTs: 100 }), tr({ entryTs: 300 })];
    const r = evaluateTradePreservation(base, variant, agg(0, 2, 0, 2), T);
    expect(r.metrics.matchedCount).toBe(1);
    expect(r.metrics.disappearedCount).toBe(1);
    expect(r.metrics.newCount).toBe(1);
  });
});

describe('end_of_data_position', () => {
  it('fires INCONCLUSIVE-worthy veto when a new EOD variant trade carries >= eodShare of a positive delta', () => {
    const base = [tr({ realizedPnl: -5 })];
    const variant = [tr({ realizedPnl: -5, entryTs: 100 }), tr({ entryTs: 999999, realizedPnl: 60, closeReason: 'end_of_data' })];
    const r = evaluateTradePreservation(base, variant, agg(-5, 1, 55, 2), T); // totalDelta = 60
    expect(r.fired).toBe(true);
    expect(r.reason).toBe('end_of_data_position');
  });
  it('does not double-count a baseline EOD trade (incremental attribution)', () => {
    const base = [tr({ entryTs: 100, realizedPnl: 50, closeReason: 'end_of_data' })];
    const variant = [tr({ entryTs: 100, realizedPnl: 60, closeReason: 'end_of_data' })];
    const r = evaluateTradePreservation(base, variant, agg(50, 1, 60, 1), T); // totalDelta=10, eodDelta=max(0,60-50)=10 >= 0.5*10
    expect(r.reason).toBe('end_of_data_position'); // still fires: incremental 10 >= 5
    expect(r.metrics.eodDelta).toBe(10);
  });
  it('does not fire when totalDelta <= 0', () => {
    const variant = [tr({ entryTs: 999999, realizedPnl: 60, closeReason: 'end_of_data' })];
    const r = evaluateTradePreservation([], variant, agg(100, 0, 100, 1), T); // totalDelta 0
    expect(r.fired).toBe(false);
  });
});

describe('abstention_gaming', () => {
  it('fires when trade count drops past threshold and removed losers explain the delta', () => {
    const base = [tr({ realizedPnl: -30, entryTs: 1 }), tr({ realizedPnl: -30, entryTs: 2 }),
                  tr({ realizedPnl: 5, entryTs: 3 }), tr({ realizedPnl: 5, entryTs: 4 }), tr({ realizedPnl: 5, entryTs: 5 })];
    const variant = [tr({ realizedPnl: 5, entryTs: 3 }), tr({ realizedPnl: 5, entryTs: 4 }), tr({ realizedPnl: 5, entryTs: 5 })];
    // baseline 5 trades net -45; variant 3 trades net 15 → totalDelta 60; dropPct 40%; removedLosers 60 >= 0.7*60
    const r = evaluateTradePreservation(base, variant, agg(-45, 5, 15, 3), T);
    expect(r.fired).toBe(true);
    expect(r.reason).toBe('abstention_gaming');
  });
});

describe('winner_degradation', () => {
  it('fires when matched+disappeared winners lose more than retention allows', () => {
    const base = [tr({ entryTs: 1, realizedPnl: 40 }), tr({ entryTs: 2, realizedPnl: 40 }),
                  tr({ entryTs: 3, realizedPnl: 40 }), tr({ entryTs: 4, realizedPnl: 40 })];
    // variant keeps one winner, drops three → contribution 40 vs gross 160; 40 < 0.9*160
    const variant = [tr({ entryTs: 1, realizedPnl: 40 })];
    const r = evaluateTradePreservation(base, variant, agg(160, 4, 40, 1), T);
    expect(r.fired).toBe(true);
    expect(r.reason).toBe('winner_degradation');
  });
  it('is skipped below minWinnerSample', () => {
    const base = [tr({ realizedPnl: 40 }), tr({ realizedPnl: 40 })]; // 2 < 3
    const r = evaluateTradePreservation(base, [], agg(80, 2, 0, 0), T);
    expect(r.reason).not.toBe('winner_degradation');
  });
});

it('returns fired:false with populated metrics when nothing triggers', () => {
  const base = [tr({ realizedPnl: 10 }), tr({ realizedPnl: 10 }), tr({ realizedPnl: 10 })];
  const variant = [tr({ realizedPnl: 12 }), tr({ realizedPnl: 12 }), tr({ realizedPnl: 12 })];
  const r = evaluateTradePreservation(base, variant, agg(30, 3, 36, 3), T);
  expect(r.fired).toBe(false);
  expect(r.reason).toBeNull();
  expect(r.metrics.totalDelta).toBe(6);
});
