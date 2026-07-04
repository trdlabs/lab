import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';

export const REVISION_EVALUATOR_VERSION = 'revision-combo-v1';

export interface RevisionComparisonInput {
  accepted: BacktestMetricBlock;
  candidate: BacktestMetricBlock;
  minTrades: number;
}

export type RevisionVerdict =
  | { decision: 'ACCEPT'; reasons: string[] }
  | { decision: 'REJECT'; reasons: string[] };

/**
 * Evaluates a candidate strategy revision against an accepted baseline.
 * Applies a first-match ladder of rejection criteria.
 *
 * Ladder (first match wins):
 * 1. candidate.totalTrades < minTrades → REJECT 'insufficient_sample'
 * 2. (candidate.netPnlUsd - accepted.netPnlUsd) <= 0 → REJECT 'no_improvement_over_accepted'
 * 3. (candidate.maxDrawdownPct - accepted.maxDrawdownPct) > 2.0 → REJECT 'drawdown_regression'
 * 4. candidate.topTradeContributionPct >= 50 → REJECT 'fragile_pnl'
 * 5. else → ACCEPT with reasons ['pnl_improved']
 */
export function evaluateRevision(input: RevisionComparisonInput): RevisionVerdict {
  const { accepted, candidate, minTrades } = input;

  // Rung 1: insufficient sample
  if (candidate.totalTrades < minTrades) {
    return { decision: 'REJECT', reasons: ['insufficient_sample'] };
  }

  // Rung 2: no improvement over accepted
  const deltaNetPnlUsd = candidate.netPnlUsd - accepted.netPnlUsd;
  if (deltaNetPnlUsd <= 0) {
    return { decision: 'REJECT', reasons: ['no_improvement_over_accepted'] };
  }

  // Rung 3: drawdown regression
  const deltaMaxDrawdownPct = candidate.maxDrawdownPct - accepted.maxDrawdownPct;
  if (deltaMaxDrawdownPct > 2.0) {
    return { decision: 'REJECT', reasons: ['drawdown_regression'] };
  }

  // Rung 4: fragile pnl
  if (candidate.topTradeContributionPct >= 50) {
    return { decision: 'REJECT', reasons: ['fragile_pnl'] };
  }

  // All checks passed: accept
  return { decision: 'ACCEPT', reasons: ['pnl_improved'] };
}
