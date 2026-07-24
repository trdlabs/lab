import type { Ref, PlatformRunConfig } from '../ports/research-platform.port.ts';
import type { ModuleBundle } from '../domain/module-bundle.ts';
import type { ComparisonSummary } from '../ports/platform-gateway.port.ts';
import type { MemberRole } from '../domain/research-experiment.ts';

export interface ExperimentRunRequest {
  experimentId: string;
  role: MemberRole;
  bundle: ModuleBundle;
  baselineRef: Ref;
  strategyProfileId: string;
  hypothesisId: string;   // REQUIRED — the executor cannot build a BacktestRun without it
  buildId: string;        // REQUIRED — persisted as BacktestRun.hypothesisBuildId
  run: PlatformRunConfig;            // includes the already-encoded period
  params: Record<string, unknown>;
  /** R12b (research-validation-hardening item 5): family-identity L1 — `hypothesisFamilyHint(hypothesis)`
   *  computed by the caller, threaded onto the trial ledger via the submitted SubmitOverlayRunOptions. */
  trialFamilyHint?: string;
}

export interface ExperimentRunResult {
  status: 'completed' | 'pending' | 'rejected';
  runId: string;         // lab BacktestRun id (PK) — stored on the member
  platformRunId: string; // backtester run id — used for getRunTrades
  comparison?: ComparisonSummary;
  totalTrades?: number;
}

export interface ExperimentRunExecutor {
  execute(req: ExperimentRunRequest): Promise<ExperimentRunResult>;
}
