import type {
  ResearchCapabilityDescriptor,
  ListDatasetsFilter,
  ListDatasetsResult,
  ValidationReport,
  ValidationIssueDTO,
  RunResultSummary,
  ComparisonSummaryDTO,
  RunJobHandle,
  RunStatusView,
  RunResultResult,
  Ref,
} from '@trading-platform/sdk/agent';
import { isTerminal } from '@trading-platform/sdk/agent';
import type { ModuleBundle } from '../domain/module-bundle.ts';

export type {
  ResearchCapabilityDescriptor, ListDatasetsFilter, ListDatasetsResult,
  ValidationReport, ValidationIssueDTO,
  RunResultSummary, ComparisonSummaryDTO,
  RunJobHandle, RunStatusView, RunResultResult, Ref,
};
export { isTerminal };

/** ok:true subset of the SDK getRunResult union. */
export type RunResultView = Extract<RunResultResult, { ok: true }>;

export interface PlatformRunConfig {
  readonly datasetId: string;
  readonly symbols: readonly string[];
  readonly timeframe: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly seed: number;
}

export interface SubmitOverlayRunOptions {
  readonly baselineModuleRef: Ref;
  readonly run: PlatformRunConfig;
  readonly correlationId?: string;
  readonly resumeToken?: string;
  readonly workflowId?: string;
}

export interface ValidateModuleOptions {
  readonly dataNeeds?: object;
}

/**
 * Research-platform lifecycle as seen by trading-lab research orchestration.
 * Separate from PlatformGatewayPort (market-context + the mock backtest path).
 * Grows in SP-7.2+ with submit / status / result / artifacts / cancel.
 */
export interface ResearchPlatformPort {
  discover(): Promise<ResearchCapabilityDescriptor>;
  listDatasets(filter?: ListDatasetsFilter): Promise<ListDatasetsResult>;
  validateModule(bundle: ModuleBundle, options?: ValidateModuleOptions): Promise<ValidationReport>;
  submitOverlayRun(bundle: ModuleBundle, opts: SubmitOverlayRunOptions): Promise<RunJobHandle>;
  getRunStatus(runId: string): Promise<RunStatusView>;
  getRunResult(runId: string): Promise<RunResultView>;
}
