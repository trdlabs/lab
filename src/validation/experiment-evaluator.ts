import { evaluateBacktest, DEFAULT_EVALUATOR_THRESHOLDS, type EvaluatorThresholds } from './evaluator.ts';
import type { ComparisonSummary } from '../ports/platform-gateway.port.ts';
import type { HoldoutBoundary, ExperimentFlags, ExperimentVerdict } from '../domain/research-experiment.ts';

export const EXPERIMENT_EVALUATOR_VERSION = 'exp-eval.1';

export interface ExperimentEvaluationInput {
  train: ComparisonSummary;
  holdout?: ComparisonSummary;
  boundary: HoldoutBoundary;
  thresholds?: EvaluatorThresholds;
}

export interface ExperimentEvaluationResult {
  verdict: ExperimentVerdict;
  verdictReason?: string;
  flags: ExperimentFlags;
  rawScores: Record<string, unknown>;
}

export function evaluateExperiment(input: ExperimentEvaluationInput): ExperimentEvaluationResult {
  const thresholds = input.thresholds ?? DEFAULT_EVALUATOR_THRESHOLDS;
  const flags: ExperimentFlags = { lowConfidenceHoldout: false, overfit: false, fragility: [], coverageWarnings: [] };

  if (input.boundary.mode === 'none') {
    return { verdict: 'INCONCLUSIVE', verdictReason: input.boundary.reason ?? 'insufficient', flags, rawScores: {} };
  }

  const train = evaluateBacktest(input.train, thresholds);
  const rawScores: Record<string, unknown> = { train: train.decision, trainReasons: train.reasons };

  // Only PASS-class train proceeds to holdout. FAIL/MODIFY/INCONCLUSIVE short-circuit with a train_* reason.
  const trainPassClass = train.decision === 'PASS' || train.decision === 'PAPER_CANDIDATE';
  if (!trainPassClass) {
    const verdict: ExperimentVerdict = train.decision === 'INCONCLUSIVE' ? 'INCONCLUSIVE' : train.decision;
    return { verdict, verdictReason: `train_${train.reasons[0] ?? 'failed'}`, flags, rawScores };
  }

  if (!input.holdout) {
    return { verdict: 'INCONCLUSIVE', verdictReason: 'holdout_not_run', flags, rawScores };
  }

  const holdout = evaluateBacktest(input.holdout, thresholds);
  rawScores.holdout = holdout.decision;
  rawScores.holdoutReasons = holdout.reasons;

  if (input.boundary.lowConfidence) {
    flags.lowConfidenceHoldout = true;
    return { verdict: 'INCONCLUSIVE', verdictReason: 'low_confidence_holdout', flags, rawScores };
  }

  if (holdout.decision === 'FAIL' || holdout.decision === 'MODIFY') {
    flags.overfit = true;
    return { verdict: 'FAIL', verdictReason: 'holdout_failed', flags, rawScores };
  }

  return { verdict: 'PAPER_CANDIDATE', verdictReason: 'holdout_passed', flags, rawScores };
}
