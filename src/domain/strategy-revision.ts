import type { ArtifactRef } from './types.ts';

export type RevisionStatus = 'candidate' | 'accepted' | 'rejected';
export type DroppedReason = 'merge_conflict_dropped' | 'combo_fail_dropped' | 'unsupported_module_shape';

export interface DroppedHypothesis {
  hypothesisId: string;
  reason: DroppedReason;
  detail: string;
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
  createdAt: string;
  updatedAt: string;
}
