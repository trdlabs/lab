import { describe, it, expect } from 'vitest';
import { rankTopN } from './top-n-prefilter.ts';
import type { GridResult } from './top-n-prefilter.ts';
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';

const mk = (o: Partial<BacktestMetricBlock>): BacktestMetricBlock => ({
  netPnlUsd: 0,
  netPnlPct: 0,
  totalTrades: 5,
  winRate: 0,
  profitFactor: 1,
  maxDrawdownPct: 0,
  expectancyUsd: 0,
  sharpe: 0,
  topTradeContributionPct: 0,
  ...o,
});

const gr = (
  paramsHash: string,
  m: Partial<BacktestMetricBlock>,
  status: GridResult['status'] = 'completed',
): GridResult => ({
  point: {},
  paramsHash,
  status,
  strategyBacktestRunId: `run-${paramsHash}`,
  metrics: mk(m),
  tradeCount: m.totalTrades ?? 5,
});

describe('rankTopN', () => {
  it('drops zero-trade + non-completed points and ranks trade-gated', () => {
    const res = rankTopN(
      [
        gr('z', { totalTrades: 0, sharpe: 9 }), // dropped (zero-trade)
        gr('r', { totalTrades: 9, sharpe: 9 }, 'rejected'), // dropped (not completed)
        gr('a', { totalTrades: 1, sharpe: 9 }), // low-confidence (< 3)
        gr('b', { totalTrades: 5, sharpe: 2 }),
        gr('c', { totalTrades: 5, sharpe: 3 }),
      ],
      { n: 3, minTradesTrain: 3 },
    );
    expect(res.map((r) => r.paramsHash)).toEqual(['c', 'b', 'a']); // full-conf by sharpe desc, then low-conf last
    expect(res.find((r) => r.paramsHash === 'a')?.lowConfidence).toBe(true);
  });

  it('returns empty when all points are zero-trade', () => {
    expect(rankTopN([gr('x', { totalTrades: 0 })], { n: 3, minTradesTrain: 3 })).toEqual([]);
  });
});
