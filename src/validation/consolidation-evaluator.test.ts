import { describe, it, expect } from 'vitest';
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';
import { evaluateConsolidation, DEFAULT_CONSOLIDATION_TOLERANCES } from './consolidation-evaluator.ts';

const M = (o: Partial<BacktestMetricBlock> = {}): BacktestMetricBlock => ({
  netPnlUsd: 100, netPnlPct: 10, totalTrades: 42, winRate: 0.6, profitFactor: 1.5,
  maxDrawdownPct: 3.2, expectancyUsd: 2.4, sharpe: 1.4, topTradeContributionPct: 12, ...o,
});

describe('evaluateConsolidation', () => {
  it('ACCEPTs exact parity', () => {
    expect(evaluateConsolidation(M(), M()).decision).toBe('ACCEPT');
  });

  it('REJECTs any trade-count change', () => {
    const v = evaluateConsolidation(M(), M({ totalTrades: 41 }));
    expect(v).toMatchObject({ decision: 'REJECT', reasons: ['trade_count_changed'] });
  });

  it('REJECTs winRate/profitFactor drift even when total/net/dd match (3 metrics are insufficient)', () => {
    const v = evaluateConsolidation(M(), M({ winRate: 0.7, profitFactor: 1.9 }));
    expect(v.decision).toBe('REJECT');
    expect(v.reasons).toContain('metric_divergence:winRate');
    expect(v.reasons).toContain('metric_divergence:profitFactor');
  });

  it('REJECTs an IMPROVEMENT (bar is "matched", not "not worse")', () => {
    expect(evaluateConsolidation(M(), M({ netPnlUsd: 500 })).decision).toBe('REJECT');
  });

  it('tolerates float-reassociation within epsilon', () => {
    expect(evaluateConsolidation(M({ netPnlUsd: 100 }), M({ netPnlUsd: 100.005 })).decision).toBe('ACCEPT');
  });

  it('skips a field absent from either block (no false REJECT)', () => {
    const a = { ...M() } as Record<string, number>; delete a.sharpe;
    expect(evaluateConsolidation(a as unknown as BacktestMetricBlock, M()).decision).toBe('ACCEPT');
  });
});
