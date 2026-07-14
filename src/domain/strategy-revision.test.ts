import { describe, it, expect } from 'vitest';
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';
import type { SelectionEvaluation, HoldoutValidation, StrategyRevision } from './strategy-revision.ts';
import { DEFAULT_REVISION_EVALUATOR_POLICY } from '../validation/revision-evaluator.ts';

// Valid BacktestMetricBlock — NO `as never`; tsc flags any wrong field.
const metrics: BacktestMetricBlock = {
  netPnlUsd: 1000, netPnlPct: 10, totalTrades: 50, winRate: 0.55, profitFactor: 2,
  maxDrawdownPct: 10, expectancyUsd: 20, sharpe: 1, topTradeContributionPct: 20,
};

describe('R5a domain types', () => {
  it('SelectionEvaluation carries baseline+candidate+policy+verdict', () => {
    const se: SelectionEvaluation = {
      evaluatorVersion: 'revision-combo-v1', baselineMetrics: metrics, candidateMetrics: metrics,
      thresholds: DEFAULT_REVISION_EVALUATOR_POLICY, decision: 'REJECT', reasons: ['drawdown_regression'],
    };
    expect(se.decision).toBe('REJECT');
  });

  it('HoldoutValidation accepts the new holdout-baseline + verdict fields', () => {
    const hv: HoldoutValidation = {
      mode: 'trade_based', reason: 'holdout_failed', trainMetrics: {}, holdoutMetrics: {},
      trainBaselineMetrics: metrics, holdoutBaselineMetrics: metrics,
      holdoutDecision: 'REJECT', holdoutReasons: ['no_improvement_over_accepted'], policy: DEFAULT_REVISION_EVALUATOR_POLICY,
    };
    expect(hv.holdoutDecision).toBe('REJECT');
  });

  it('StrategyRevision carries optional selectionEvaluation', () => {
    const r: Partial<StrategyRevision> = { selectionEvaluation: undefined };
    expect('selectionEvaluation' in r).toBe(true);
  });
});
