import type { RevisionVerdict } from './revision-evaluator.ts';
import type { TradeRecord } from '../domain/research-experiment.ts';
import {
  evaluateTradePreservation,
  type PreservationAggregates,
  type PreservationThresholds,
  type PreservationMetadata,
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
