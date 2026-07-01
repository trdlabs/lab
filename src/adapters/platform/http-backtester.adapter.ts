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
import { createModuleBundle } from '@trading-backtester/sdk/builder';
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
import type { GatewayError } from '../../ports/research-run-lifecycle.ts';
import type { ModuleBundle } from '../../domain/module-bundle.ts';
import type { BacktesterStrategyPort, StrategyRunResult, StrategyRunSubmission } from '../../ports/backtester-strategy.port.ts';
import { GatewayRunError, GatewayValidationError } from './gateway-errors.ts';
import { toBacktesterBundle } from './backtester-bundle.ts';
import type { RunTradesPort } from '../../ports/run-trades.port.ts';
import type { TradeRecord } from '../../domain/research-experiment.ts';

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
  getArtifactManifest(runId: string): Promise<{
    descriptors: readonly { artifactType: string; contentHash: string; availability: string; approxItemCount?: number }[];
  }>;
  readArtifact(runId: string, artifactId: string, opts?: { offset?: number; limit?: number }): Promise<{
    page: readonly unknown[]; total: number; offset: number; nextCursor?: string;
  }>;
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

export class HttpBacktesterAdapter implements ResearchPlatformPort, BacktesterStrategyPort {
  private readonly client: BacktesterClientLike;
  /** Memoized: the registry is immutable for the life of the adapter, so discover it at most once. */
  private registryPromise?: Promise<RegistryDescriptor>;
  private readonly goldenResultHash?: string;
  private readonly maxPollMs: number;
  private readonly pollIntervalMs: number;

  constructor(client: BacktesterClientLike, opts?: { goldenResultHash?: string; maxPollMs?: number; pollIntervalMs?: number }) {
    this.client = client;
    this.goldenResultHash = opts?.goldenResultHash;
    this.maxPollMs = opts?.maxPollMs ?? 120_000;
    this.pollIntervalMs = opts?.pollIntervalMs ?? 1000;
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
    const descriptor = await this.registry(); // memoized — no extra round-trip
    // The submitted overlay targets the preset's baseline, so the bundle manifest's targetStrategyRef
    // must be the preset baseline id (the backtester validates it against the run's baseline).
    const btBundle = toBacktesterBundle(bundle, {
      targetStrategyRef: preset.baselineRef.id,
      contractVersion: descriptor.contractVersion,
    });
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
      // The preset is a COMPLETE, self-sufficient scaffold: it advertises the full metric set the
      // research comparison/evaluation needs (total_trades / profit_factor / top_trade_contribution_pct),
      // so trust preset.metrics directly.
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

  // ── BacktesterStrategyPort ────────────────────────────────────────────────

  /** Poll until the run reaches a terminal status, bounded by maxPollMs. Throws if the deadline is exceeded. */
  private async pollUntilTerminal(runId: string): Promise<void> {
    const deadline = Date.now() + this.maxPollMs;
    while (Date.now() < deadline) {
      const view = await this.client.getRunStatus(runId);
      if (TERMINAL.has(view.status)) return;
      await new Promise<void>((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    throw new Error(`pollUntilTerminal: run ${runId} did not reach a terminal status within ${this.maxPollMs}ms`);
  }

  /**
   * Submit a strategy bundle for a deterministic backtest, poll until completion, and compare the
   * result hash against the adapter's configured golden hash. Returns:
   *   - `equivalent` — resultHash matches the golden anchor
   *   - `divergent`  — resultHash differs (carries divergence metadata)
   *   - `unavailable` — client connection/timeout error (never throws)
   */
  async submitStrategyRun(s: StrategyRunSubmission): Promise<StrategyRunResult> {
    try {
      // Build the backtester wire bundle: manifest from the submission (already a BundleManifest),
      // entry = single compiled ESM file, files = decoded bytes.
      const strategyBundle = createModuleBundle({
        manifest: s.manifest,
        entry: 'index.js',
        files: { 'index.js': new TextDecoder().decode(s.bundleBytes) },
      });
      const req: BtRunSubmitRequest = {
        engine: 'strategy',
        moduleRef: { id: s.manifest.id, version: s.manifest.version },
        moduleBundle: strategyBundle,
        datasetRef: s.scope.datasetRef,
        symbols: s.scope.symbols,
        timeframe: s.scope.timeframe,
        period: {
          from: new Date(s.scope.window.fromMs).toISOString(),
          to: new Date(s.scope.window.toMs).toISOString(),
        },
        mode: 'research',
        seed: 0,
        metrics: [],
      };
      const { runId } = await this.client.submitRun(req);
      await this.pollUntilTerminal(runId);
      const summary = await this.client.getRunResult(runId);
      const resultHash = summary.resultHash;
      if (resultHash === undefined || this.goldenResultHash === undefined) {
        // No result hash (or no configured golden) → cannot prove equivalence; never read missing data as a match.
        return { status: 'unavailable' };
      }
      if (resultHash === this.goldenResultHash) {
        return { status: 'equivalent', resultHash };
      }
      return {
        status: 'divergent',
        resultHash,
        divergence: { bar: -1, field: 'result_hash', expected: this.goldenResultHash, actual: resultHash },
      };
    } catch {
      return { status: 'unavailable' };
    }
  }
}

// ── RunTradesPort implementation ────────────────────────────────────────────

function parseTrade(row: unknown): TradeRecord {
  const r = row as Record<string, unknown>;
  if (typeof r.entryTs !== 'number' || typeof r.exitTs !== 'number') {
    throw new Error('trades artifact row missing entryTs/exitTs');
  }
  return {
    entryTs: r.entryTs,
    exitTs: r.exitTs,
    side: r.side === 'short' ? 'short' : 'long',
    realizedPnl: typeof r.realizedPnl === 'number' ? r.realizedPnl : 0,
  };
}

export class HttpBacktesterRunTradesAdapter implements RunTradesPort {
  private readonly client: BacktesterClientLike;
  constructor(client: BacktesterClientLike) {
    this.client = client;
  }

  async getRunTrades(runId: string): Promise<TradeRecord[]> {
    const manifest = await this.client.getArtifactManifest(runId);
    const tradesDesc = manifest.descriptors.find(
      (d) => d.artifactType === 'trades' && d.availability === 'available',
    );
    if (!tradesDesc) return [];

    const out: TradeRecord[] = [];
    let offset = 0;
    const limit = 500;
    for (;;) {
      const pageRes = await this.client.readArtifact(runId, tradesDesc.contentHash, { offset, limit });
      for (const row of pageRes.page) out.push(parseTrade(row));
      const consumed = offset + pageRes.page.length;
      if (pageRes.page.length === 0 || consumed >= pageRes.total) break;
      offset = consumed;
    }
    return out;
  }
}
