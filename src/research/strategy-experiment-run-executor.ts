import type { MemberRole } from '../domain/research-experiment.ts';
import type { AssembledStrategyBundle } from '../domain/strategy-bundle.ts';
import type { PlatformRunConfig } from '../ports/research-platform.port.ts';
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';

/**
 * Strategy-lane counterpart to `ExperimentRunRequest`/`ExperimentRunResult` (overlay lane): submits
 * an `engine:'strategy'` run for a standalone `AssembledStrategyBundle` (no baseline/comparison — see
 * `ResearchPlatformPort.submitStrategyResearchRun`), persists a `StrategyBacktestRun`, and maps the
 * resulting `RunResultSummary` into a `BacktestMetricBlock` via `mapStrategyMetrics`.
 */
export interface StrategyExperimentRunRequest {
  readonly experimentId: string;
  readonly role: MemberRole;
  readonly strategyBundle: AssembledStrategyBundle;
  readonly strategyProfileId: string;
  readonly run: PlatformRunConfig;
  readonly params: Record<string, unknown>;
  readonly metrics: string[];
}

export interface StrategyExperimentRunResult {
  readonly status: 'completed' | 'pending' | 'rejected';
  readonly runId: string;
  readonly platformRunId: string;
  readonly metrics?: BacktestMetricBlock;
  readonly totalTrades?: number;
}

export interface StrategyExperimentRunExecutor {
  execute(req: StrategyExperimentRunRequest): Promise<StrategyExperimentRunResult>;
}
