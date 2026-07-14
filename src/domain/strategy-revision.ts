import type { ArtifactRef } from './types.ts';
import type { PreservationMetadata } from '../validation/trade-preservation.ts';
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';
import type { RevisionDecision, RevisionEvaluatorPolicy } from '../validation/revision-evaluator.ts';

export type RevisionStatus = 'candidate' | 'accepted' | 'rejected';
export type DroppedReason = 'merge_conflict_dropped' | 'combo_fail_dropped' | 'unsupported_module_shape';

export interface DroppedHypothesis {
  hypothesisId: string;
  reason: DroppedReason;
  detail: string;
}

/** Persisted decision-inputs of the revision's selection-window evaluation (R5a). */
export interface SelectionEvaluation {
  evaluatorVersion: string;
  baselineMetrics: BacktestMetricBlock;
  candidateMetrics: BacktestMetricBlock;
  thresholds: RevisionEvaluatorPolicy;
  decision: RevisionDecision;
  reasons: string[];
}

export type HoldoutValidationReason =
  | 'skipped_insufficient_history'
  | 'skipped_insufficient_trades'
  | 'boundary_unavailable'
  | 'holdout_passed'
  | 'holdout_failed';

export interface HoldoutValidation {
  mode: 'none' | 'trade_based';
  t?: string;
  reason: HoldoutValidationReason;
  lowConfidence?: boolean;
  trainMetrics?: Record<string, unknown>;
  holdoutMetrics?: Record<string, unknown>;
  // R5a: full baseline↔candidate comparison + verdict on both windows (explainable ROBUSTNESS)
  trainBaselineMetrics?: BacktestMetricBlock;
  holdoutBaselineMetrics?: BacktestMetricBlock;
  holdoutDecision?: RevisionDecision;
  holdoutReasons?: string[];
  policy?: RevisionEvaluatorPolicy;
}

export interface StrategyRevision {
  id: string;
  strategyProfileId: string;
  version: number;                        // monotonic per profile; UNIQUE(profileId, version)
  baseRevisionId?: string;                // null => v1 bootstrap from G1 baseline
  hypothesisIds: string[];
  dropped?: DroppedHypothesis[];
  mergedRuleSet: Record<string, unknown>; // { order: hypothesisId[], rules: RuleAction[] }
  bundleArtifactRef?: ArtifactRef;        // composed revision STRATEGY bundle
  bundleHash?: string;
  comboBacktestRunId?: string;            // strategy-lane StrategyBacktestRun id (validation run)
  status: RevisionStatus;
  metrics?: Record<string, unknown>;      // BacktestMetricBlock of the accepted run
  verdictReason?: string;
  preservationGate?: PreservationMetadata;
  holdoutValidation?: HoldoutValidation;
  selectionEvaluation?: SelectionEvaluation;
  kind?: 'composed' | 'consolidated';        // default 'composed' when absent
  consolidatedFromRevisionId?: string;       // consolidated: the R it materializes
  semanticParentRevisionId?: string;         // composed: baseRevisionId; consolidated: R.id
  compositionDepth?: number;                 // default 1; consolidation resets to 1
  baselineValidationStatus?: 'pending' | 'passed' | 'inconclusive' | 'failed';
  baselineExperimentId?: string;
  baselineTaskId?: string;
  createdAt: string;
  updatedAt: string;
}
