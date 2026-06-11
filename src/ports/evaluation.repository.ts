// src/ports/evaluation.repository.ts
import type { Evaluation } from '../domain/evaluation.ts';

export interface EvaluationRepository {
  create(evaluation: Evaluation): Promise<void>;
  findById(id: string): Promise<Evaluation | null>;
  listByBacktestRun(backtestRunId: string): Promise<Evaluation[]>;
}
