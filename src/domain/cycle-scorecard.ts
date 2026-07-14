import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';
import type { RevisionDecision, RevisionEvaluatorPolicy } from '../validation/revision-evaluator.ts';
import type { SelectionEvaluation, HoldoutValidation } from './strategy-revision.ts';
import type { PreservationMetadata } from '../validation/trade-preservation.ts';
import type { EvaluationDecision } from '../validation/evaluator.ts';

export const CYCLE_SCORECARD_SCHEMA_VERSION = 'cycle-scorecard-v1';

export type TerminalKind = 'accepted' | 'rejected' | 'skipped' | 'abandoned';

export interface ScorecardCounts {
  built: number;
  evaluated: number;
  eligible: number | null;
  considered: number | null;
  selected: number;
  dropped: number;
}

/** §AGGREGATE — baseline-relative ladder from the revision's SelectionEvaluation; deltas derived by the builder. */
export interface ScorecardAggregate {
  evaluatorVersion: string;
  baselineMetrics: BacktestMetricBlock;
  candidateMetrics: BacktestMetricBlock;
  deltas: { netPnlUsd: number; maxDrawdownPct: number; totalTrades: number };
  thresholds: RevisionEvaluatorPolicy;
  decision: RevisionDecision;
  reasons: string[];
}

export interface RevisionAssessment {
  revisionId: string;
  version: number;
  status: 'accepted' | 'rejected';
  aggregate: ScorecardAggregate | null;      // null when selectionEvaluation absent (final attempt no comparison / consolidated)
  tradeSplit: PreservationMetadata | null;    // R2 (may reflect a different attempt than aggregate — do not couple)
  robustness: HoldoutValidation | null;       // R3a train/holdout + verdict
}

export interface RosterEntry {
  hypId: string;
  lastDecision: EvaluationDecision | null;
  terminalStatus: string;                     // hypothesis.status at scorecard time
  considered: boolean;
}

export interface CycleScorecard {
  schemaVersion: typeof CYCLE_SCORECARD_SCHEMA_VERSION;
  correlationId: string;
  strategyProfileId: string;
  terminalOutcome: { kind: TerminalKind; reason: string };
  counts: ScorecardCounts;
  eligibleUnavailableReason?: string;
  consideredUnavailableReason?: string;
  provenance: { mergeAttempted: boolean; candidateIncluded: number; revisionId?: string; sourceTaskId?: string };
  revisionAssessment: RevisionAssessment | null;
  champion: { revisionId: string; version: number } | null;
  selectionBias: { n: number | null; considered: number | null; selected: number };
  roster: RosterEntry[];
  verdict: { decision: string; reason: string };
}
