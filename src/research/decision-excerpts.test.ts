import { describe, it, expect } from 'vitest';
import { toDecisionExcerpts, DECISION_EXCERPT_CAP } from './decision-excerpts.ts';
import type { DecisionLogEntry, ClosedTrade } from '../ports/bot-results-read.port.ts';

function trade(over: Partial<ClosedTrade>): ClosedTrade {
  return { tradeId: 't1', runId: 'r1', symbol: 'HUSDT', side: 'long', openedAtMs: 1_000_000, closedAtMs: 2_000_000,
    entryPrice: null, exitPrice: null, realizedPnl: '-1', pnlPct: '-1', isWin: false, closeReason: null, closeReasonRaw: null, ...over };
}
function entry(over: Partial<DecisionLogEntry>): DecisionLogEntry {
  return { category: 'hold', runId: 'r1', botId: 'b1', symbol: 'HUSDT', side: 'long', reason: 'oi rising', tsMs: 1_500_000, safeMessage: 'held through pullback', ...over };
}

describe('toDecisionExcerpts', () => {
  it('keeps entries inside a loser window and maps SDK fields', () => {
    const r = toDecisionExcerpts([entry({})], [trade({})]);
    expect(r).toEqual([{ runId: 'r1', timestampMs: 1_500_000, action: 'hold', reason: 'oi rising', summary: 'held through pullback', relatedTradeId: 't1' }]);
  });
  it('captures the entry decision logged up to 60s before openedAtMs', () => {
    const r = toDecisionExcerpts([entry({ tsMs: 1_000_000 - 30_000 })], [trade({})]);
    expect(r).toHaveLength(1);
  });
  it('drops entries outside every window', () => {
    expect(toDecisionExcerpts([entry({ tsMs: 5_000_000 })], [trade({})])).toEqual([]);
  });
  it('requires same runId (no cross-run match on overlapping ts)', () => {
    expect(toDecisionExcerpts([entry({ runId: 'rX' })], [trade({ runId: 'r1' })])).toEqual([]);
  });
  it('treats closedAtMs null as an upper bound of openedAtMs', () => {
    const r = toDecisionExcerpts([entry({ tsMs: 1_000_000 })], [trade({ closedAtMs: null })]);
    expect(r).toHaveLength(1);
    expect(toDecisionExcerpts([entry({ tsMs: 1_500_000 })], [trade({ closedAtMs: null })])).toEqual([]);
  });
  it('on overlap, the first loser in selection order wins', () => {
    const losers = [trade({ tradeId: 'first', openedAtMs: 1_000_000, closedAtMs: 3_000_000 }),
                    trade({ tradeId: 'second', openedAtMs: 1_000_000, closedAtMs: 3_000_000 })];
    const r = toDecisionExcerpts([entry({ tsMs: 2_000_000 })], losers);
    expect(r[0]?.relatedTradeId).toBe('first');
  });
  it('caps at DECISION_EXCERPT_CAP, ordered by loser selection then tsMs', () => {
    const entries = Array.from({ length: 30 }, (_, i) => entry({ tsMs: 1_100_000 + i }));
    const r = toDecisionExcerpts(entries, [trade({})]);
    expect(r).toHaveLength(DECISION_EXCERPT_CAP);
    expect(r[0]?.timestampMs).toBe(1_100_000);
  });
});
