// src/domain/evaluation.ts
import type { ComparisonSummary } from '../ports/platform-gateway.port.ts';
import type { EvaluationDecision, EvaluatorThresholds } from '../validation/evaluator.ts';

export interface Evaluation {
  id: string;
  backtestRunId: string;
  hypothesisId: string;
  decision: EvaluationDecision;
  reasons: string[];
  metricsSnapshot: ComparisonSummary;
  thresholds: EvaluatorThresholds;
  createdAt: string;
}
