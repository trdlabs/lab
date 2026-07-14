import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';

export const REVISION_EVALUATOR_VERSION = 'revision-combo-v1';

/** Versioned, explicit evaluator thresholds. Persisted verbatim (no reconstruction from constants). */
export interface RevisionEvaluatorPolicy {
  evaluatorVersion: string;
  minTrades: number;
  minNetPnlImprovementUsd: number;
  maxDrawdownRegressionPct: number;
  topTradeContributionPct: number;
}

export const DEFAULT_REVISION_EVALUATOR_POLICY: RevisionEvaluatorPolicy = {
  evaluatorVersion: REVISION_EVALUATOR_VERSION,
  minTrades: 20,
  minNetPnlImprovementUsd: 0,
  maxDrawdownRegressionPct: 2.0,
  topTradeContributionPct: 50,
};

export interface RevisionComparisonInput {
  accepted: BacktestMetricBlock;
  candidate: BacktestMetricBlock;
}

export type RevisionVerdict =
  | { decision: 'ACCEPT'; reasons: string[] }
  | { decision: 'REJECT'; reasons: string[] };

export type RevisionDecision = RevisionVerdict['decision'];

/**
 * Ladder (first match wins), all thresholds from `policy`:
 * 1. candidate.totalTrades < policy.minTrades → REJECT 'insufficient_sample'
 * 2. (candidate.netPnlUsd - accepted.netPnlUsd) <= policy.minNetPnlImprovementUsd → REJECT 'no_improvement_over_accepted'
 * 3. (candidate.maxDrawdownPct - accepted.maxDrawdownPct) > policy.maxDrawdownRegressionPct → REJECT 'drawdown_regression'
 * 4. candidate.topTradeContributionPct >= policy.topTradeContributionPct → REJECT 'fragile_pnl'
 * 5. else → ACCEPT ['pnl_improved']
 */
export function evaluateRevision(input: RevisionComparisonInput, policy: RevisionEvaluatorPolicy): RevisionVerdict {
  const { accepted, candidate } = input;

  if (candidate.totalTrades < policy.minTrades) {
    return { decision: 'REJECT', reasons: ['insufficient_sample'] };
  }
  const deltaNetPnlUsd = candidate.netPnlUsd - accepted.netPnlUsd;
  if (deltaNetPnlUsd <= policy.minNetPnlImprovementUsd) {
    return { decision: 'REJECT', reasons: ['no_improvement_over_accepted'] };
  }
  const deltaMaxDrawdownPct = candidate.maxDrawdownPct - accepted.maxDrawdownPct;
  if (deltaMaxDrawdownPct > policy.maxDrawdownRegressionPct) {
    return { decision: 'REJECT', reasons: ['drawdown_regression'] };
  }
  if (candidate.topTradeContributionPct >= policy.topTradeContributionPct) {
    return { decision: 'REJECT', reasons: ['fragile_pnl'] };
  }
  return { decision: 'ACCEPT', reasons: ['pnl_improved'] };
}
