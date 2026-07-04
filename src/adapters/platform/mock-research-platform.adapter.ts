import { randomUUID, createHash } from 'node:crypto';
import { CONTRACT_VERSION } from '@trdlabs/sdk';
import { stableStringify } from '../../orchestrator/handlers/backtest-support.ts';
import type {
  ResearchPlatformPort,
  ResearchCapabilityDescriptor,
  ListDatasetsFilter,
  ListDatasetsResult,
  ValidationReport,
  ValidateModuleOptions,
  SubmitOverlayRunOptions,
  SubmitStrategyResearchRunOptions,
  RunJobHandle,
  RunStatusView,
  RunResultView,
  RunResultSummary,
} from '../../ports/research-platform.port.ts';
import type { ModuleBundle } from '../../domain/module-bundle.ts';
import type { AssembledStrategyBundle } from '../../domain/strategy-bundle.ts';

/**
 * Deterministically perturbs a canned strategy-metrics baseline from the submitted grid params,
 * so distinct grid points resolve to distinct, reproducible metrics. Empty params are a no-op —
 * this preserves byte-identical baseline metrics for existing overlay/baseline tests.
 */
function perturbMetrics(base: Record<string, number>, params: Record<string, unknown>): Record<string, number> {
  if (Object.keys(params).length === 0) return base;
  const h = createHash('sha256').update(stableStringify(params)).digest();
  const f = (i: number) => (h[i]! / 255);
  return {
    ...base,
    pnl: base.pnl! * (0.5 + f(0)),
    sharpe: (base.sharpe ?? 0) + (f(1) - 0.5),
    total_trades: Math.max(1, Math.round((base.total_trades ?? 3) * (0.5 + f(2)))),
    max_drawdown: (base.max_drawdown ?? 0) * (0.5 + f(3)),
  };
}

export class MockResearchPlatformAdapter implements ResearchPlatformPort {
  // Runs submitted via submitStrategyResearchRun — resolved with a metrics-only (no comparison)
  // summary by getRunResult, distinct from the overlay lane's baseline-vs-variant canned summary.
  // Value is the submitted opts.params (possibly {}), used to perturb the fabricated metrics.
  private readonly strategyRuns = new Map<string, Record<string, unknown>>();

  async discover(): Promise<ResearchCapabilityDescriptor> {
    return {
      contractVersion: CONTRACT_VERSION,
      supportedContractVersions: [CONTRACT_VERSION],
      marketDataKinds: [
        { kind: 'funding', access: 'as_of_freshness', coverageStates: ['present'], presentZeroDistinct: true, since: '2020-01-01' },
      ],
      runModes: [{ mode: 'single', description: 'mock single run' }],
      metricCatalog: ['netPnlUsd', 'sharpe', 'maxDrawdownPct'],
      robustnessCatalog: ['seed_sweep'],
    };
  }

  async listDatasets(_filter?: ListDatasetsFilter): Promise<ListDatasetsResult> {
    return {
      datasets: [
        {
          datasetId: 'mock-ds-1',
          symbols: ['ESPORTSUSDT'],
          dateRange: { from: '2026-06-12', to: '2026-06-18' },
          timeframe: '1h',
          coveredKinds: [{ kind: 'funding', state: 'present' }],
        },
      ],
    };
  }

  async validateModule(_bundle: ModuleBundle, _options?: ValidateModuleOptions): Promise<ValidationReport> {
    return { status: 'accepted', issues: [], executed: false };
  }

  private cannedSummary(runId: string): RunResultSummary {
    const m = { pnl: 1500, sharpe: 1.6, max_drawdown: 0.14, win_rate: 0.58, total_trades: 42, profit_factor: 2.1, top_trade_contribution_pct: 28 };
    const baseline = { ...m, pnl: 800, profit_factor: 1.5 };
    return {
      runId, status: 'completed', runKind: 'baseline-vs-variant', validationIssues: [],
      metrics: baseline,
      comparison: {
        baseline,
        variant: m,
        deltas: Object.fromEntries(Object.keys(m).map((k) => [k, (m as Record<string, number>)[k] ?? 0 - ((baseline as Record<string, number>)[k] ?? 0)])),
      },
      coverage: [], artifactRefs: [], evidence: { seed: 0, contractVersion: CONTRACT_VERSION, moduleVersions: [] },
    } as RunResultSummary;
  }

  private cannedStrategySummary(runId: string, params: Record<string, unknown> = {}): RunResultSummary {
    const base = { pnl: 1500, sharpe: 1.6, max_drawdown: 0.14, win_rate: 0.58, total_trades: 42, profit_factor: 2.1, top_trade_contribution_pct: 28 };
    const metrics = perturbMetrics(base, params);
    return {
      runId, status: 'completed', runKind: 'baseline-only', validationIssues: [],
      metrics,
      coverage: [], artifactRefs: [], evidence: { seed: 0, contractVersion: CONTRACT_VERSION, moduleVersions: [] },
    } as RunResultSummary;
  }

  async submitOverlayRun(_bundle: ModuleBundle, opts: SubmitOverlayRunOptions): Promise<RunJobHandle> {
    const runId = randomUUID();
    return { jobId: randomUUID(), runId, status: 'accepted', effectiveSeed: opts.run.seed, requestFingerprint: 'mock', idempotentReplay: false };
  }

  async submitStrategyResearchRun(_bundle: AssembledStrategyBundle, opts: SubmitStrategyResearchRunOptions): Promise<RunJobHandle> {
    const runId = randomUUID();
    this.strategyRuns.set(runId, opts.params ?? {});
    return {
      jobId: randomUUID(), runId, status: 'accepted', effectiveSeed: opts.run.seed,
      requestFingerprint: 'mock', idempotentReplay: false, correlationId: opts.correlationId,
    };
  }

  async getRunStatus(runId: string): Promise<RunStatusView> {
    return { jobId: 'mock', runId, status: 'completed', timeline: { acceptedAtMs: 0, terminalAtMs: 1 } };
  }

  async getRunResult(runId: string): Promise<RunResultView> {
    const strategyParams = this.strategyRuns.get(runId);
    const summary = strategyParams !== undefined
      ? this.cannedStrategySummary(runId, strategyParams)
      : this.cannedSummary(runId);
    return { ok: true, kind: 'summary', summary };
  }
}
