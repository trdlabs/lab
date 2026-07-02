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
} from './research-run-lifecycle.ts';
import { isTerminal } from './research-run-lifecycle.ts';
import type { ModuleBundle } from '../domain/module-bundle.ts';
import type { AssembledStrategyBundle } from '../domain/strategy-bundle.ts';

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
  /**
   * What the run compares the submitted overlay bundle against. Per-integration support is
   * deliberate (see the adapters): the backtester/HTTP path needs a COMPLETE request
   * (risk/exec/metrics), which only a `registry_preset` supplies, so it rejects `baseline_ref`;
   * the mock accepts both.
   */
  readonly target:
    | { readonly kind: 'registry_preset'; readonly presetId?: string }
    | { readonly kind: 'baseline_ref'; readonly moduleRef: Ref };
  readonly run: PlatformRunConfig;
  readonly correlationId?: string;
  readonly resumeToken?: string;
  readonly workflowId?: string;
  /** When set, backtester/platform POST a CompletionEvent here on terminal transition. */
  readonly callbackUrl?: string;
}

export interface ValidateModuleOptions {
  readonly dataNeeds?: object;
}

/**
 * Options for submitting a standalone (metrics-producing, non-comparison) `engine:'strategy'` run —
 * used by the strategy-baseline lane to get a real, pollable backtest of a strategy bundle by
 * itself (no overlay/preset target). Distinct from `BacktesterStrategyPort.submitStrategyRun`, which
 * is a golden-hash equivalence PROBE (signed/equivalent/divergent) — this returns a `RunJobHandle`
 * that flows through the normal getRunStatus/getRunResult poll lifecycle.
 */
export interface SubmitStrategyResearchRunOptions {
  readonly run: PlatformRunConfig;
  readonly correlationId: string;
  /** Non-empty subset of the overlay metric catalog; threaded from the caller. */
  readonly metrics: readonly string[];
  /** request.params overrides merged over manifest.params by the engine (WFO sweep point). Omit/empty = manifest defaults. */
  readonly params?: Record<string, unknown>;
  readonly resumeToken?: string;
  readonly workflowId?: string;
  /** When set, backtester/platform POST a CompletionEvent here on terminal transition. */
  readonly callbackUrl?: string;
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
  submitStrategyResearchRun(bundle: AssembledStrategyBundle, opts: SubmitStrategyResearchRunOptions): Promise<RunJobHandle>;
  getRunStatus(runId: string): Promise<RunStatusView>;
  getRunResult(runId: string): Promise<RunResultView>;
}
