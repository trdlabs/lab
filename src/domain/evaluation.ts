// src/domain/evaluation.ts
import type { ComparisonSummary } from '../ports/platform-gateway.port.ts';
import type { EvaluationDecision, EvaluatorThresholds } from '../validation/evaluator.ts';
import type { PreservationMetadata } from '../validation/trade-preservation.ts';

export interface Evaluation {
  id: string;
  backtestRunId: string;
  hypothesisId: string;
  decision: EvaluationDecision;
  reasons: string[];
  metricsSnapshot: ComparisonSummary;
  thresholds: EvaluatorThresholds;
  createdAt: string;
  preservationGate?: PreservationMetadata;
}
