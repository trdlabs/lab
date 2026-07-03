import type { AssembledStrategyBundle } from '../domain/strategy-bundle.ts';
import type { PlatformRunConfig } from './research-platform.port.ts';
import type { BacktestMetricBlock } from './platform-gateway.port.ts';

/**
 * Strategy-lane seam through which a strategy-revisions candidate (and, when missing, its
 * comparison-baseline run) executes as a REAL strategy backtest — mirrors
 * `StrategyExperimentRunExecutor` but is keyed by revisionId/label instead of experimentId/role,
 * and dedups by-key against an existing COMPLETED run before submitting (see
 * `BacktesterRevisionRunExecutor`).
 */
export interface RevisionRunRequest {
  readonly revisionId: string;
  readonly label: 'candidate' | 'comparison_baseline';
  readonly strategyBundle: AssembledStrategyBundle;
  readonly strategyProfileId: string;
  readonly run: PlatformRunConfig;
  readonly metrics: string[];
  readonly correlationId: string;
}

export interface RevisionRunResult {
  readonly status: 'completed' | 'pending' | 'rejected';
  readonly runId: string;
  readonly platformRunId: string;
  readonly metrics?: BacktestMetricBlock;
  readonly totalTrades?: number;
}

export interface StrategyRevisionRunExecutor {
  execute(req: RevisionRunRequest): Promise<RevisionRunResult>;
}
