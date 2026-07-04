import type { StrategyBacktestRun, StrategyBacktestCompletion } from '../domain/strategy-backtest-run.ts';

export interface StrategyBacktestRunRepository {
  createSubmitted(run: StrategyBacktestRun): Promise<void>;
  markCompleted(id: string, completion: StrategyBacktestCompletion): Promise<void>;
  markRejected(id: string): Promise<void>;
  markFailed(id: string): Promise<void>;
  findById(id: string): Promise<StrategyBacktestRun | null>;
  findByPlatformRunId(platformRunId: string): Promise<StrategyBacktestRun | null>;
  findByIdentity(strategyBundleId: string, paramsHash: string, bundleHash: string): Promise<StrategyBacktestRun | null>;
  /** Same identity lookup as `findByIdentity` — named for the revision-lane dedup call site (§3 same-run-context comparison idempotency). */
  findByBundleAndParams(strategyBundleId: string, paramsHash: string, bundleHash: string): Promise<StrategyBacktestRun | null>;
}
