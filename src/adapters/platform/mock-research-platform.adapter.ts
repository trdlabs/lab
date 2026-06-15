import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSION } from '@trading-platform/sdk';
import type {
  ResearchPlatformPort,
  ResearchCapabilityDescriptor,
  ListDatasetsFilter,
  ListDatasetsResult,
  ValidationReport,
  ValidateModuleOptions,
  SubmitOverlayRunOptions,
  RunJobHandle,
  RunStatusView,
  RunResultView,
  RunResultSummary,
} from '../../ports/research-platform.port.ts';
import type { ModuleBundle } from '../../domain/module-bundle.ts';

export class MockResearchPlatformAdapter implements ResearchPlatformPort {
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
          symbols: ['BTCUSDT'],
          dateRange: { from: '2023-01-01', to: '2023-12-31' },
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

  async submitOverlayRun(_bundle: ModuleBundle, opts: SubmitOverlayRunOptions): Promise<RunJobHandle> {
    const runId = randomUUID();
    return { jobId: randomUUID(), runId, status: 'accepted', effectiveSeed: opts.run.seed, requestFingerprint: 'mock', idempotentReplay: false };
  }

  async getRunStatus(runId: string): Promise<RunStatusView> {
    return { jobId: 'mock', runId, status: 'completed', timeline: { acceptedAtMs: 0, terminalAtMs: 1 } };
  }

  async getRunResult(runId: string): Promise<RunResultView> {
    return { ok: true, kind: 'summary', summary: this.cannedSummary(runId) };
  }
}
