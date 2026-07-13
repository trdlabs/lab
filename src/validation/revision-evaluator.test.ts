import { describe, it, expect } from 'vitest';
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';
import {
  evaluateRevision,
  REVISION_EVALUATOR_VERSION,
  DEFAULT_REVISION_EVALUATOR_POLICY,
  type RevisionComparisonInput,
  type RevisionVerdict,
} from './revision-evaluator.ts';

describe('revision-evaluator', () => {
  const baseMetrics = {
    netPnlUsd: 1000,
    netPnlPct: 10,
    totalTrades: 50,
    winRate: 0.6,
    profitFactor: 1.5,
    maxDrawdownPct: 15,
    expectancyUsd: 20,
    sharpe: 1.2,
    topTradeContributionPct: 30,
  };

  describe('version', () => {
    it('exports REVISION_EVALUATOR_VERSION', () => {
      expect(REVISION_EVALUATOR_VERSION).toBe('revision-combo-v1');
    });
  });

  describe('ladder: insufficient_sample', () => {
    it('rejects when candidate.totalTrades < minTrades', () => {
      const input: RevisionComparisonInput = {
        accepted: baseMetrics,
        candidate: { ...baseMetrics, totalTrades: 10 },
      };
      const result = evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY);
      expect(result.decision).toBe('REJECT');
      expect(result.reasons).toContain('insufficient_sample');
    });

    it('accepts when candidate.totalTrades === minTrades (boundary)', () => {
      const input: RevisionComparisonInput = {
        accepted: baseMetrics,
        candidate: { ...baseMetrics, totalTrades: 20, netPnlUsd: 1100 },
      };
      const result = evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY);
      expect(result.decision).toBe('ACCEPT');
    });

    it('accepts when candidate.totalTrades > minTrades', () => {
      const input: RevisionComparisonInput = {
        accepted: baseMetrics,
        candidate: { ...baseMetrics, totalTrades: 50, netPnlUsd: 1100 },
      };
      const result = evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY);
      expect(result.decision).toBe('ACCEPT');
    });
  });

  describe('ladder: no_improvement_over_accepted', () => {
    it('rejects when deltaNetPnl < 0', () => {
      const input: RevisionComparisonInput = {
        accepted: baseMetrics,
        candidate: { ...baseMetrics, netPnlUsd: 900 },
      };
      const result = evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY);
      expect(result.decision).toBe('REJECT');
      expect(result.reasons).toContain('no_improvement_over_accepted');
    });

    it('rejects when deltaNetPnl === 0 (boundary)', () => {
      const input: RevisionComparisonInput = {
        accepted: baseMetrics,
        candidate: { ...baseMetrics, netPnlUsd: 1000 },
      };
      const result = evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY);
      expect(result.decision).toBe('REJECT');
      expect(result.reasons).toContain('no_improvement_over_accepted');
    });

    it('accepts when deltaNetPnl > 0', () => {
      const input: RevisionComparisonInput = {
        accepted: baseMetrics,
        candidate: { ...baseMetrics, netPnlUsd: 1100 },
      };
      const result = evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY);
      expect(result.decision).toBe('ACCEPT');
    });
  });

  describe('ladder: drawdown_regression', () => {
    it('accepts when deltaMaxDrawdown <= 2.0 (boundary)', () => {
      const input: RevisionComparisonInput = {
        accepted: { ...baseMetrics, maxDrawdownPct: 15 },
        candidate: { ...baseMetrics, maxDrawdownPct: 17, netPnlUsd: 1100 },
      };
      const result = evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY);
      expect(result.decision).toBe('ACCEPT');
    });

    it('rejects when deltaMaxDrawdown > 2.0', () => {
      const input: RevisionComparisonInput = {
        accepted: { ...baseMetrics, maxDrawdownPct: 15 },
        candidate: { ...baseMetrics, maxDrawdownPct: 17.1, netPnlUsd: 1100 },
      };
      const result = evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY);
      expect(result.decision).toBe('REJECT');
      expect(result.reasons).toContain('drawdown_regression');
    });

    it('rejects when deltaMaxDrawdown is significantly > 2.0', () => {
      const input: RevisionComparisonInput = {
        accepted: { ...baseMetrics, maxDrawdownPct: 15 },
        candidate: { ...baseMetrics, maxDrawdownPct: 20, netPnlUsd: 1100 },
      };
      const result = evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY);
      expect(result.decision).toBe('REJECT');
      expect(result.reasons).toContain('drawdown_regression');
    });
  });

  describe('ladder: fragile_pnl', () => {
    it('accepts when topTradeContributionPct < 50 (boundary)', () => {
      const input: RevisionComparisonInput = {
        accepted: baseMetrics,
        candidate: { ...baseMetrics, topTradeContributionPct: 49.9, netPnlUsd: 1100 },
      };
      const result = evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY);
      expect(result.decision).toBe('ACCEPT');
    });

    it('rejects when topTradeContributionPct === 50 (boundary)', () => {
      const input: RevisionComparisonInput = {
        accepted: baseMetrics,
        candidate: { ...baseMetrics, topTradeContributionPct: 50, netPnlUsd: 1100 },
      };
      const result = evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY);
      expect(result.decision).toBe('REJECT');
      expect(result.reasons).toContain('fragile_pnl');
    });

    it('rejects when topTradeContributionPct > 50', () => {
      const input: RevisionComparisonInput = {
        accepted: baseMetrics,
        candidate: { ...baseMetrics, topTradeContributionPct: 60, netPnlUsd: 1100 },
      };
      const result = evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY);
      expect(result.decision).toBe('REJECT');
      expect(result.reasons).toContain('fragile_pnl');
    });
  });

  describe('ladder: accept with pnl_improved', () => {
    it('accepts when all conditions pass', () => {
      const input: RevisionComparisonInput = {
        accepted: baseMetrics,
        candidate: {
          netPnlUsd: 1100,
          netPnlPct: 11,
          totalTrades: 50,
          winRate: 0.65,
          profitFactor: 1.6,
          maxDrawdownPct: 16,
          expectancyUsd: 22,
          sharpe: 1.3,
          topTradeContributionPct: 35,
        },
      };
      const result = evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY);
      expect(result.decision).toBe('ACCEPT');
      expect(result.reasons).toContain('pnl_improved');
    });

    it('accepts with minimal improvement and good metrics', () => {
      const input: RevisionComparisonInput = {
        accepted: baseMetrics,
        candidate: {
          netPnlUsd: 1001,
          netPnlPct: 10.01,
          totalTrades: 50,
          winRate: 0.6,
          profitFactor: 1.5,
          maxDrawdownPct: 15,
          expectancyUsd: 20.02,
          sharpe: 1.2,
          topTradeContributionPct: 30,
        },
      };
      const result = evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY);
      expect(result.decision).toBe('ACCEPT');
      expect(result.reasons).toContain('pnl_improved');
    });
  });

  describe('ladder: first-match behavior', () => {
    it('rejects insufficient_sample before checking pnl improvement', () => {
      const input: RevisionComparisonInput = {
        accepted: baseMetrics,
        candidate: { ...baseMetrics, totalTrades: 5, netPnlUsd: 2000 },
      };
      const result = evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY);
      expect(result.decision).toBe('REJECT');
      expect(result.reasons).toContain('insufficient_sample');
      expect(result.reasons).not.toContain('no_improvement_over_accepted');
    });

    it('rejects no_improvement before checking drawdown', () => {
      const input: RevisionComparisonInput = {
        accepted: baseMetrics,
        candidate: { ...baseMetrics, netPnlUsd: 900, maxDrawdownPct: 25 },
      };
      const result = evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY);
      expect(result.decision).toBe('REJECT');
      expect(result.reasons).toContain('no_improvement_over_accepted');
      expect(result.reasons).not.toContain('drawdown_regression');
    });

    it('rejects drawdown before checking fragility', () => {
      const input: RevisionComparisonInput = {
        accepted: baseMetrics,
        candidate: {
          ...baseMetrics,
          netPnlUsd: 1100,
          maxDrawdownPct: 20,
          topTradeContributionPct: 60,
        },
      };
      const result = evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY);
      expect(result.decision).toBe('REJECT');
      expect(result.reasons).toContain('drawdown_regression');
      expect(result.reasons).not.toContain('fragile_pnl');
    });
  });

  describe('edge cases', () => {
    it('handles zero netPnlUsd', () => {
      const input: RevisionComparisonInput = {
        accepted: { ...baseMetrics, netPnlUsd: 0 },
        candidate: { ...baseMetrics, netPnlUsd: 100 },
      };
      const result = evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY);
      expect(result.decision).toBe('ACCEPT');
    });

    it('handles negative netPnlUsd', () => {
      const input: RevisionComparisonInput = {
        accepted: { ...baseMetrics, netPnlUsd: -500 },
        candidate: { ...baseMetrics, netPnlUsd: -100 },
      };
      const result = evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY);
      expect(result.decision).toBe('ACCEPT');
    });

    it('handles very high maxDrawdownPct values', () => {
      const input: RevisionComparisonInput = {
        accepted: { ...baseMetrics, maxDrawdownPct: 50 },
        candidate: { ...baseMetrics, maxDrawdownPct: 52.5, netPnlUsd: 1100 },
      };
      const result = evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY);
      expect(result.decision).toBe('REJECT');
      expect(result.reasons).toContain('drawdown_regression');
    });

    it('handles topTradeContributionPct at 99.9%', () => {
      const input: RevisionComparisonInput = {
        accepted: baseMetrics,
        candidate: { ...baseMetrics, topTradeContributionPct: 99.9, netPnlUsd: 1100 },
      };
      const result = evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY);
      expect(result.decision).toBe('REJECT');
      expect(result.reasons).toContain('fragile_pnl');
    });

    it('accepts topTradeContributionPct at 49.99%', () => {
      const input: RevisionComparisonInput = {
        accepted: baseMetrics,
        candidate: { ...baseMetrics, topTradeContributionPct: 49.99, netPnlUsd: 1100 },
      };
      const result = evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY);
      expect(result.decision).toBe('ACCEPT');
    });
  });
});

// Valid BacktestMetricBlock (exact 9 fields — NO `as never`, so a wrong field name fails tsc).
const M = (over: Partial<BacktestMetricBlock> = {}): BacktestMetricBlock => ({
  netPnlUsd: 1000, netPnlPct: 10, totalTrades: 50, winRate: 0.55, profitFactor: 2,
  maxDrawdownPct: 10, expectancyUsd: 20, sharpe: 1, topTradeContributionPct: 20, ...over,
});

describe('evaluateRevision — policy-driven thresholds', () => {
  it('DEFAULT policy carries the exact shipped values', () => {
    expect(DEFAULT_REVISION_EVALUATOR_POLICY).toEqual({
      evaluatorVersion: REVISION_EVALUATOR_VERSION,
      minTrades: 20, minNetPnlImprovementUsd: 0, maxDrawdownRegressionPct: 2.0, topTradeContributionPct: 50,
    });
  });

  it('uses policy.minTrades (rung 1)', () => {
    const input = { accepted: M(), candidate: M({ netPnlUsd: 1100, totalTrades: 10 }) };
    expect(evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY).reasons).toEqual(['insufficient_sample']); // 10 < 20
    expect(evaluateRevision(input, { ...DEFAULT_REVISION_EVALUATOR_POLICY, minTrades: 5 }).decision).toBe('ACCEPT'); // 10 >= 5
  });

  it('uses policy.minNetPnlImprovementUsd (rung 2)', () => {
    const input = { accepted: M({ netPnlUsd: 1000 }), candidate: M({ netPnlUsd: 1050 }) }; // +50 improvement
    expect(evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY).decision).toBe('ACCEPT'); // 50 > 0
    const strict = evaluateRevision(input, { ...DEFAULT_REVISION_EVALUATOR_POLICY, minNetPnlImprovementUsd: 100 });
    expect(strict.decision).toBe('REJECT'); // 50 <= 100
    expect(strict.reasons).toEqual(['no_improvement_over_accepted']);
  });

  it('uses policy.maxDrawdownRegressionPct (rung 3, not a literal 2.0)', () => {
    const input = { accepted: M(), candidate: M({ netPnlUsd: 1100, maxDrawdownPct: 13 }) }; // +3pp drawdown
    expect(evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY).decision).toBe('REJECT'); // default 2.0
    expect(evaluateRevision(input, { ...DEFAULT_REVISION_EVALUATOR_POLICY, maxDrawdownRegressionPct: 5.0 }).decision).toBe('ACCEPT');
  });

  it('uses policy.topTradeContributionPct (rung 4, not a literal 50)', () => {
    const input = { accepted: M(), candidate: M({ netPnlUsd: 1100, topTradeContributionPct: 45 }) };
    expect(evaluateRevision(input, DEFAULT_REVISION_EVALUATOR_POLICY).decision).toBe('ACCEPT'); // 45 < 50
    expect(evaluateRevision(input, { ...DEFAULT_REVISION_EVALUATOR_POLICY, topTradeContributionPct: 40 }).decision).toBe('REJECT'); // 45 >= 40
  });
});
