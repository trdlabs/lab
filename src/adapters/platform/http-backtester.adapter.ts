// HttpBacktesterAdapter — implements ResearchPlatformPort by talking to the trading-backtester service
// through @trading-backtester/sdk. This is the target-architecture boundary: trading-lab submits /
// polls / reads backtests via the backtesterClient (separate from the platform client), not the MCP
// gateway. Selected by `selectResearchPlatform('backtester')`.
//
// Type bridging (backtester wire ↔ platform SDK):
//  - RunJobHandle is structurally identical → passed through.
//  - RunStatusView.timeline: backtester array of {status,atMs} → SDK object {acceptedAtMs,...}.
//  - RunResultSummary: backtester is baseline-only; the SDK summary needs runKind + a comparison. We
//    set runKind:'baseline-only' and a DELIBERATELY-degenerate comparison (baseline = metrics, EMPTY
//    variant + deltas) — never a fake baseline-vs-variant with computed-zero deltas — so a future real
//    comparison stays distinguishable from "no comparison" (see ADR / Slice 5 guardrail).

import type {
  ModuleBundle as BacktesterModuleBundle,
  CapabilityDescriptor as BtCapabilityDescriptor,
  DatasetDescriptor as BtDatasetDescriptor,
  RunResultSummary as BtRunResultSummary,
  RunStatusView as BtRunStatusView,
  RunSubmitRequest as BtRunSubmitRequest,
  ValidationReport as BtValidationReport,
  ComparisonSummary as BtComparisonSummary,
  MetricDelta as BtMetricDelta,
  RegistryDescriptor,
  OverlayRunPreset,
} from '@trading-backtester/sdk/contracts';
import { BacktesterConflictError, BacktesterError } from '@trading-backtester/sdk/client';
import type {
  ResearchPlatformPort,
  ResearchCapabilityDescriptor,
  ListDatasetsFilter,
  ListDatasetsResult,
  ValidationReport,
  SubmitOverlayRunOptions,
  ValidateModuleOptions,
  RunJobHandle,
  RunStatusView,
  RunResultView,
} from '../../ports/research-platform.port.ts';
import type { GatewayError } from '@trading-platform/sdk/agent';
import type { ModuleBundle } from '../../domain/module-bundle.ts';
import { GatewayRunError, GatewayValidationError } from './gateway-errors.ts';
import { toBacktesterBundle } from './backtester-bundle.ts';

/** The subset of BacktesterClient the adapter uses (so tests can inject a fake). */
export interface BacktesterClientLike {
  submitRun(req: BtRunSubmitRequest): Promise<RunJobHandle>;
  getRunStatus(runId: string): Promise<BtRunStatusView>;
  getRunResult(runId: string): Promise<BtRunResultSummary>;
  validateModule(req: unknown): Promise<BtValidationReport>;
  getCapabilities(): Promise<BtCapabilityDescriptor>;
  discoverRegistry(): Promise<RegistryDescriptor>;
  listDatasets(): Promise<BtDatasetDescriptor[]>;
  cancelRun(runId: string): Promise<BtRunStatusView>;
}

const TERMINAL = new Set(['completed', 'failed', 'canceled', 'expired', 'timed_out']);

function toGatewayError(err: unknown): GatewayError {
  if (err instanceof BacktesterError) {
    const category = (err.category as GatewayError['category'] | undefined) ??
      (err.status === 400 ? 'validation_error' : 'internal_gateway_error');
    return { category, code: err.code, message: err.message };
  }
  return { category: 'internal_gateway_error', code: 'client_error', message: String((err as Error)?.message ?? err) };
}

function toSdkStatusView(v: BtRunStatusView): RunStatusView {
  const at = (status: string): number | undefined => v.timeline.find((e) => e.status === status)?.atMs;
  const terminal = v.timeline.find((e) => TERMINAL.has(e.status));
  return {
    jobId: v.jobId,
    runId: v.runId,
    status: v.status,
    timeline: {
      acceptedAtMs: at('accepted') ?? 0,
      ...(at('queued') !== undefined ? { queuedAtMs: at('queued') } : {}),
      ...(at('running') !== undefined ? { startedAtMs: at('running') } : {}),
      ...(terminal !== undefined ? { terminalAtMs: terminal.atMs } : {}),
    },
    ...(v.terminalCode !== undefined ? { terminalCode: v.terminalCode } : {}),
  };
}

/**
 * Synthetic, explicitly baseline-only comparison: baseline carries the metrics, variant + deltas are
 * EMPTY. This is present (so pollOverlayRun accepts a completed run) yet unmistakably not a real
 * baseline-vs-variant — a future real comparison has a populated variant + computed deltas.
 */
function baselineOnlyComparison(metrics: Record<string, number>): {
  baseline: Record<string, number>;
  variant: Record<string, number>;
  deltas: Record<string, number>;
} {
  return { baseline: { ...metrics }, variant: {}, deltas: {} };
}

function toSdkComparison(c: BtComparisonSummary): { baseline: Record<string, number>; variant: Record<string, number>; deltas: Record<string, number> } {
  const first = c.variants[0];
  if (!first) return { baseline: {}, variant: {}, deltas: {} };
  const baseline: Record<string, number> = {};
  const variant: Record<string, number> = {};
  const deltas: Record<string, number> = {};
  for (const [key, md] of Object.entries(first.metricDeltas) as [string, BtMetricDelta][]) {
    baseline[key] = md.baseline;
    variant[key] = md.variant;
    deltas[key] = md.delta;
  }
  return { baseline, variant, deltas };
}

function toSdkSummary(s: BtRunResultSummary): Extract<RunResultView, { kind: 'summary' }>['summary'] {
  const hasComparison = s.comparison !== undefined;
  return {
    runId: s.runId,
    status: s.status,
    runKind: hasComparison ? 'baseline-vs-variant' : 'baseline-only',
    validationIssues: [],
    metrics: s.metrics,
    comparison: hasComparison ? toSdkComparison(s.comparison!) : baselineOnlyComparison(s.metrics),
    coverage: [],
    artifactRefs: s.artifactRefs.map((a) => ({
      artifactId: a.artifactId,
      artifactType: a.artifactType as Extract<RunResultView, { kind: 'summary' }>['summary']['artifactRefs'][number]['artifactType'],
      availability: { status: a.availability },
      ...(a.approxItemCount !== undefined ? { approxItemCount: a.approxItemCount } : {}),
    })),
    evidence: {
      seed: s.evidence.seed,
      contractVersion: s.evidence.contractVersion,
      moduleVersions: s.evidence.moduleVersions,
    },
  };
}

function toSdkValidationReport(r: BtValidationReport): ValidationReport {
  return {
    status: r.status,
    issues: r.issues.map((i) => ({
      severity: i.severity,
      code: i.code,
      message: i.message,
      path: i.path ?? '',
    })),
    executed: false,
  };
}

export class HttpBacktesterAdapter implements ResearchPlatformPort {
  private readonly client: BacktesterClientLike;
  /** Memoized: the registry is immutable for the life of the adapter, so discover it at most once. */
  private registryPromise?: Promise<RegistryDescriptor>;

  constructor(client: BacktesterClientLike) {
    this.client = client;
  }

  private registry(): Promise<RegistryDescriptor> {
    return (this.registryPromise ??= this.client.discoverRegistry());
  }

  /**
   * Resolve the overlay-run preset that supplies the COMPLETE request (baseline + risk + exec +
   * metrics). With a presetId, look it up; without one, auto-select the sole preset, else demand a
   * presetId. The backtester needs all of these — a bare baseline_ref cannot be submitted.
   */
  private async resolvePreset(presetId?: string): Promise<OverlayRunPreset> {
    const presets = (await this.registry()).overlayRunPresets;
    if (presetId) {
      const p = presets.find((x) => x.id === presetId);
      if (!p) throw new GatewayRunError({ category: 'validation_error', code: 'unknown_preset', message: `unknown overlay preset: ${presetId}` });
      return p;
    }
    if (presets.length === 1) return presets[0]!;
    throw new GatewayRunError({ category: 'validation_error', code: 'ambiguous_preset', message: `presetId required; available: ${presets.map((p) => p.id).join(', ')}` });
  }

  async discover(): Promise<ResearchCapabilityDescriptor> {
    const caps = await this.client.getCapabilities();
    return {
      contractVersion: caps.contractVersion,
      supportedContractVersions: [caps.contractVersion],
      marketDataKinds: [],
      runModes: [{ mode: 'single', description: 'baseline-only strategy run' }],
      metricCatalog: caps.supportedMetrics,
      robustnessCatalog: [],
    };
  }

  async listDatasets(_filter?: ListDatasetsFilter): Promise<ListDatasetsResult> {
    const datasets = await this.client.listDatasets();
    return {
      datasets: datasets.map((d) => ({
        datasetId: d.datasetRef,
        symbols: d.symbols,
        dateRange: { from: d.period.from, to: d.period.to },
        timeframe: d.timeframe,
        coveredKinds: [],
      })),
    };
  }

  async validateModule(bundle: ModuleBundle, _options?: ValidateModuleOptions): Promise<ValidationReport> {
    try {
      const report = await this.client.validateModule({ moduleBundle: toBacktesterBundle(bundle) });
      return toSdkValidationReport(report);
    } catch (err) {
      throw new GatewayValidationError(toGatewayError(err));
    }
  }

  async submitOverlayRun(bundle: ModuleBundle, opts: SubmitOverlayRunOptions): Promise<RunJobHandle> {
    if (opts.target.kind === 'baseline_ref') {
      // A bare baseline_ref carries no risk/exec/metrics — the backtester overlay engine would reject
      // the incomplete request. The preset is the only complete source here.
      throw new GatewayRunError({
        category: 'validation_error',
        code: 'unsupported_target',
        message: 'the backtester integration requires a registry_preset target (baseline_ref is not supported)',
      });
    }
    const preset = await this.resolvePreset(opts.target.presetId);
    const btBundle = toBacktesterBundle(bundle);
    const req: BtRunSubmitRequest = {
      mode: 'research',
      engine: 'overlay',
      moduleRef: preset.baselineRef,
      overlayRefs: [{ id: btBundle.manifest.id, version: btBundle.manifest.version }],
      riskProfileRef: preset.riskProfileRef,
      executionProfileRef: preset.executionProfileRef,
      moduleBundle: btBundle,
      datasetRef: opts.run.datasetId,
      symbols: opts.run.symbols,
      timeframe: opts.run.timeframe,
      period: opts.run.period,
      seed: opts.run.seed,
      metrics: [...preset.metrics],
      ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
      ...(opts.resumeToken !== undefined ? { resumeToken: opts.resumeToken } : {}),
      ...(opts.workflowId !== undefined ? { workflowId: opts.workflowId } : {}),
      ...(opts.callbackUrl !== undefined ? { callbackUrl: opts.callbackUrl } : {}),
    };
    try {
      return await this.client.submitRun(req);
    } catch (err) {
      throw new GatewayRunError(toGatewayError(err));
    }
  }

  async getRunStatus(runId: string): Promise<RunStatusView> {
    try {
      return toSdkStatusView(await this.client.getRunStatus(runId));
    } catch (err) {
      throw new GatewayRunError(toGatewayError(err));
    }
  }

  async getRunResult(runId: string): Promise<RunResultView> {
    try {
      const summary = await this.client.getRunResult(runId);
      return { ok: true, kind: 'summary', summary: toSdkSummary(summary) };
    } catch (err) {
      if (err instanceof BacktesterConflictError) {
        // Not complete, or a terminal run with no result summary (failed/timed_out/...): return the
        // status view — pollOverlayRun maps that to a rejection with the terminalCode.
        const view = await this.client.getRunStatus(runId);
        return { ok: true, kind: 'status', view: toSdkStatusView(view) };
      }
      throw new GatewayRunError(toGatewayError(err));
    }
  }
}
