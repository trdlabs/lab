// src/ports/backtest-run.repository.ts
import type { BacktestRun, BacktestCompletion } from '../domain/backtest-run.ts';

export interface BacktestRunRepository {
  createSubmitted(run: BacktestRun): Promise<void>;
  markCompleted(id: string, completion: BacktestCompletion): Promise<void>;
  markRejected(id: string): Promise<void>;
  markFailed(id: string): Promise<void>;
  markEvaluated(id: string): Promise<void>;
  findById(id: string): Promise<BacktestRun | null>;
  /** Identity lookup powering pre-submit idempotency (matches the DB unique key). */
  findByIdentity(hypothesisId: string, paramsHash: string, bundleHash: string): Promise<BacktestRun | null>;
  listByHypothesis(hypothesisId: string): Promise<BacktestRun[]>;
  /** Pending platform-backed runs eligible for resume: status='submitted' AND backend='research_platform'. */
  listResumablePlatformRuns(): Promise<BacktestRun[]>;
}
