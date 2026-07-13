import type { RevisionVerdict } from './revision-evaluator.ts';
import type { EvaluationOutcome } from './evaluator.ts';
import type { TradeRecord } from '../domain/research-experiment.ts';
import {
  evaluateTradePreservation,
  type PreservationAggregates,
  type PreservationThresholds,
  type PreservationMetadata,
  type PreservationReason,
} from './trade-preservation.ts';

export interface RevisionGateResult {
  verdict: RevisionVerdict;
  preservation: PreservationMetadata | null;
}

/**
 * Downgrade-only preservation veto for the revision lane. Evaluates trades only when the
 * incoming verdict is ACCEPT; a fired veto flips ACCEPT→REJECT with the veto reason. Never
 * upgrades and never touches a REJECT verdict.
 */
export function applyRevisionPreservationGate(
  verdict: RevisionVerdict,
  baselineTrades: TradeRecord[],
  variantTrades: TradeRecord[],
  agg: PreservationAggregates,
  thresholds: PreservationThresholds,
): RevisionGateResult {
  if (verdict.decision !== 'ACCEPT') return { verdict, preservation: null };
  const preservation = evaluateTradePreservation(baselineTrades, variantTrades, agg, thresholds);
  if (!preservation.fired) return { verdict, preservation };
  return { verdict: { decision: 'REJECT', reasons: [preservation.reason!] }, preservation };
}

export interface BacktestGateResult {
  outcome: EvaluationOutcome;
  preservation: PreservationMetadata | null;
}

const BACKTEST_VETO_DECISION = {
  end_of_data_position: 'INCONCLUSIVE',
  abstention_gaming: 'MODIFY',
  winner_degradation: 'MODIFY',
} as const satisfies Record<PreservationReason, EvaluationOutcome['decision']>;

/**
 * Downgrade-only preservation veto for the hypothesis proxy lane. Evaluates trades only when the
 * incoming verdict is would-accept (PASS or PAPER_CANDIDATE). A fired veto downgrades:
 * end_of_data_position → INCONCLUSIVE, abstention_gaming/winner_degradation → MODIFY. Never upgrades.
 */
export function applyBacktestPreservationGate(
  outcome: EvaluationOutcome,
  baselineTrades: TradeRecord[],
  variantTrades: TradeRecord[],
  agg: PreservationAggregates,
  thresholds: PreservationThresholds,
): BacktestGateResult {
  if (outcome.decision !== 'PASS' && outcome.decision !== 'PAPER_CANDIDATE') {
    return { outcome, preservation: null };
  }
  const preservation = evaluateTradePreservation(baselineTrades, variantTrades, agg, thresholds);
  if (!preservation.fired) return { outcome, preservation };
  return {
    outcome: { decision: BACKTEST_VETO_DECISION[preservation.reason!], reasons: [preservation.reason!] },
    preservation,
  };
}
