// Research run-lifecycle vocabulary — trading-lab's own port contract.
//
// These types were historically re-exported from `@trdlabs/sdk/agent` (the platform
// research-gateway 031 DTOs). After the MCP integration was retired (Инициатива #2), lab no longer
// talks to that gateway, and `@trdlabs/sdk@0.5.0` cut the `/agent` subpath. lab now OWNS this
// vocabulary: it is the shape that `ResearchPlatformPort` exposes and that the surviving mock + HTTP
// backtester adapters translate their backends into. Shapes are kept byte-identical to the former SDK
// `/agent` DTOs so the adapters' mapping logic is unchanged.

export type ContentHash = `sha256:${string}`;

export interface Ref {
  readonly id: string;
  readonly version: string;
}

export type ArtifactType =
  | 'run-summary' | 'metrics' | 'trades' | 'decision-records' | 'simulated-orders'
  | 'simulated-fills' | 'risk-decisions' | 'equity-curve' | 'validation-issues'
  | 'deferred-robustness' | 'sandbox-errors' | 'comparison';

export type RunKind = 'baseline-only' | 'baseline-vs-variant';

export type MarketDataKind = 'openInterest' | 'liquidations' | 'funding' | 'taker';
export type MarketDataCoverageState = 'present' | 'missing' | 'stale' | 'unsupported';
export type MarketDataAccess = 'point_in_time' | 'as_of_freshness' | 'bucket_flow';

export interface MarketDataKindDescriptor {
  readonly kind: MarketDataKind;
  readonly access: MarketDataAccess;
  readonly coverageStates: readonly MarketDataCoverageState[];
  readonly presentZeroDistinct: boolean;
  readonly since: string;
}

export type RunMode = 'single' | 'baseline_variant' | 'strategy_overlay';
export interface RunModeDescriptor {
  readonly mode: RunMode;
  readonly description: string;
}

export interface ResearchCapabilityDescriptor {
  readonly contractVersion: string;
  readonly supportedContractVersions: readonly string[];
  readonly marketDataKinds: readonly MarketDataKindDescriptor[];
  readonly runModes: readonly RunModeDescriptor[];
  readonly metricCatalog: readonly string[];
  readonly robustnessCatalog: readonly string[];
}

export interface CoveredKind {
  readonly kind: MarketDataKind;
  readonly state: MarketDataCoverageState;
}

export interface DatasetDescriptor {
  readonly datasetId: string;
  readonly symbols: readonly string[];
  readonly dateRange: { readonly from: string; readonly to: string };
  readonly timeframe: string;
  readonly coveredKinds: readonly CoveredKind[];
}

export interface ListDatasetsFilter {
  readonly symbol?: string;
  readonly period?: { readonly from?: string; readonly to?: string };
}

export interface ListDatasetsResult {
  readonly datasets: readonly DatasetDescriptor[];
}

export interface RunJobHandle {
  readonly jobId: string;
  readonly runId: string;
  readonly status: 'accepted';
  readonly effectiveSeed: number;
  readonly requestFingerprint: string;
  readonly correlationId?: string;
  readonly workflowId?: string;
  readonly idempotentReplay: boolean;
}

export type NonTerminalRunStatus = 'accepted' | 'queued' | 'running';
export type TerminalRunStatus = 'completed' | 'failed' | 'canceled' | 'expired' | 'timed_out';
export type RunStatus = NonTerminalRunStatus | TerminalRunStatus;

export interface RunTimeline {
  readonly acceptedAtMs: number;
  readonly queuedAtMs?: number;
  readonly startedAtMs?: number;
  readonly terminalAtMs?: number;
}

export interface RunStatusView {
  readonly jobId: string;
  readonly runId: string;
  readonly status: RunStatus;
  readonly correlationId?: string;
  readonly workflowId?: string;
  readonly timeline: RunTimeline;
  readonly terminalCode?: string;
}

export interface ArtifactReference {
  readonly artifactId: ContentHash;
  readonly artifactType: ArtifactType;
  readonly availability: {
    readonly status: 'available' | 'unavailable' | 'not_applicable';
    readonly reasonCode?: string;
  };
  readonly approxItemCount?: number;
}

export interface CoverageEntryDTO {
  readonly symbol: string;
  readonly kind: MarketDataKind;
  readonly state: MarketDataCoverageState;
  readonly coveredMinutes: number;
  readonly gapMinutes: number;
}

export interface ComparisonSummaryDTO {
  readonly baseline: Record<string, number>;
  readonly variant: Record<string, number>;
  readonly deltas: Record<string, number>;
}

export interface ValidationIssueDTO {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export interface ValidationReport {
  readonly status: 'accepted' | 'accepted_with_warnings' | 'rejected';
  readonly issues: readonly ValidationIssueDTO[];
  readonly executed: false;
}

/**
 * E2 (research-validation-hardening R1): advisory Deflated Sharpe Ratio + trial provenance,
 * copied byte-identical from `@trdlabs/backtester-sdk/contracts` TrialContext (dist/contracts/index.d.ts).
 * NEVER part of any hashed result payload — DSR depends on the family's trial history (stateful),
 * so it lives on this projection only, present solely when the backtester's trial ledger is enabled.
 */
export interface TrialContext {
  readonly familyKey: string;
  readonly familyHint?: string;
  readonly trialCount: number;
  readonly deflatedSharpe: number;
  readonly sr0: number;
  readonly vSR: number;
  readonly vSRBasis: 'asymptotic' | 'empirical';
  readonly tCount: number;
}

export interface RunResultSummary {
  readonly runId: string;
  readonly status: RunStatus;
  readonly runKind: RunKind;
  readonly validationIssues: readonly ValidationIssueDTO[];
  readonly metrics: Record<string, number>;
  readonly comparison?: ComparisonSummaryDTO;
  readonly coverage: readonly CoverageEntryDTO[];
  readonly artifactRefs: readonly ArtifactReference[];
  readonly evidence: {
    readonly seed: number;
    readonly contractVersion: string;
    readonly moduleVersions: readonly Ref[];
  };
  /** E2: advisory trial count + Deflated Sharpe. NOT covered by any result hash. */
  readonly trialContext?: TrialContext;
}

export type GatewayErrorCategory =
  | 'validation_error' | 'missing_dataset' | 'unsupported_data_needs'
  | 'sandbox_module_error' | 'runner_failure' | 'internal_gateway_error'
  // Backpressure (backtester 429 queue_full / SDK BacktesterRateLimitError): the run was NOT
  // created — safe to retry the submit later; resumeToken makes the replay idempotent.
  | 'rate_limited';

export interface GatewayError {
  readonly category: GatewayErrorCategory;
  readonly code: string;
  readonly message: string;
}

export type RunResultResult =
  | { readonly ok: true; readonly kind: 'summary'; readonly summary: RunResultSummary }
  | { readonly ok: true; readonly kind: 'status'; readonly view: RunStatusView }
  | { readonly ok: false; readonly error: GatewayError };

/** The 5 terminal run statuses. */
export const TERMINAL_STATUSES: readonly TerminalRunStatus[] = [
  'completed', 'failed', 'canceled', 'expired', 'timed_out',
];

/** True if a run status is terminal. */
export function isTerminal(status: RunStatus): status is TerminalRunStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}
