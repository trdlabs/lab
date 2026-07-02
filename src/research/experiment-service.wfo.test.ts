// src/research/experiment-service.wfo.test.ts
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ExperimentService, DEFAULT_WFO_BUDGET } from './experiment-service.ts';
import type { RunWfoInput, WfoBudget } from './experiment-service.ts';
import { ParamGridRunner } from './param-grid-runner.ts';
import { BacktesterStrategyExperimentRunExecutor } from './backtester-strategy-experiment-run-executor.ts';
import { FakeGate1 } from '../adapters/wfo/fake-gate1.ts';
import { FakeSweepDesigner } from '../adapters/wfo/fake-sweep-designer.ts';
import { FakeResultInterpreter } from '../adapters/wfo/fake-result-interpreter.ts';
import type { ResultInterpreterPort, InterpretInput } from '../ports/wfo-agents.port.ts';
import type { ResultInterpretOutput } from '../domain/wfo.ts';
import { InMemoryResearchExperimentRepository } from '../adapters/repository/in-memory-research-experiment.repository.ts';
import { InMemoryStrategyBacktestRunRepository } from '../adapters/repository/in-memory-strategy-backtest-run.repository.ts';
import { FakeRunTradesAdapter } from '../adapters/platform/fake-run-trades.adapter.ts';
import type {
  ResearchPlatformPort, ResearchCapabilityDescriptor, ListDatasetsFilter, ListDatasetsResult,
  ValidationReport, ValidateModuleOptions, SubmitOverlayRunOptions, SubmitStrategyResearchRunOptions,
  RunJobHandle, RunStatusView, RunResultView,
} from '../ports/research-platform.port.ts';
import type { ModuleBundle } from '../domain/module-bundle.ts';
import type { AssembledStrategyBundle } from '../domain/strategy-bundle.ts';
import type { StrategyProfile, StrategyParameter } from '../domain/strategy-profile.ts';
import { DEFAULT_HOLDOUT_POLICY, type HoldoutBoundary } from '../domain/research-experiment.ts';
import { STRATEGY_RUN_KIND } from '../domain/strategy-backtest-run.ts';
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const NOW = '2026-01-01T00:00:00.000Z';
const BUNDLE_HASH = 'sha256:wfo-bundle';
const T = '2023-04-01T00:00:00.000Z';
const DATASET_SCOPE = {
  datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h',
  period: { from: '2023-01-01T00:00:00.000Z', to: '2023-06-30T00:00:00.000Z' },
};
const RUN_CONFIG = { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', seed: 7 };

function bundle(): AssembledStrategyBundle {
  return { bytes: new Uint8Array(), source: 'x', manifest: { id: 'sb-wfo' } as never, bundleHash: BUNDLE_HASH };
}

function profile(params: StrategyParameter[]): StrategyProfile {
  return {
    id: 'p1', version: 1, sourceKind: 'bot_code', sourceFingerprint: 'fp',
    direction: 'long', coreIdea: 'x', requiredMarketFeatures: [], confidence: 0.8, unknowns: [],
    profile: {
      direction: 'long', coreIdea: 'x', summary: 's', requiredMarketFeatures: [],
      entryConditions: [], exitConditions: [], timeframes: ['1h'], indicators: [],
      parameters: params, watchLifecycleSummary: null, positionManagementSummary: null,
      riskManagementSummary: null, runnerOwnedAuthorities: [], confidence: 0.8, unknowns: [], evidence: [],
    },
    sourceArtifactRef: {} as never, contractVersion: 'v1', createdAt: NOW, updatedAt: NOW,
  };
}

function metrics(over: Partial<BacktestMetricBlock>): BacktestMetricBlock {
  return {
    netPnlUsd: 0, netPnlPct: 0, totalTrades: 0, winRate: 0, profitFactor: 0,
    maxDrawdownPct: 0, expectancyUsd: 0, sharpe: 0, topTradeContributionPct: 0,
    ...over,
  };
}

type ResultForFn = (params: Record<string, unknown>) => { totalTrades: number; rejected?: boolean; sharpe?: number };

/** Fake ResearchPlatformPort whose strategy-run outcome varies deterministically by submitted params. */
class FakeWfoPlatform implements ResearchPlatformPort {
  private readonly runs = new Map<string, Record<string, unknown>>();
  private seq = 0;
  private readonly resultFor: ResultForFn;
  constructor(resultFor: ResultForFn) { this.resultFor = resultFor; }

  async discover(): Promise<ResearchCapabilityDescriptor> { throw new Error('not used'); }
  async listDatasets(_filter?: ListDatasetsFilter): Promise<ListDatasetsResult> { throw new Error('not used'); }
  async validateModule(_bundle: ModuleBundle, _options?: ValidateModuleOptions): Promise<ValidationReport> { throw new Error('not used'); }
  async submitOverlayRun(_bundle: ModuleBundle, _opts: SubmitOverlayRunOptions): Promise<RunJobHandle> { throw new Error('not used'); }

  async submitStrategyResearchRun(_bundle: AssembledStrategyBundle, opts: SubmitStrategyResearchRunOptions): Promise<RunJobHandle> {
    const runId = `run-${++this.seq}`;
    this.runs.set(runId, opts.params ?? {});
    return {
      jobId: runId, runId, status: 'accepted', effectiveSeed: opts.run.seed,
      requestFingerprint: 'fake', idempotentReplay: false, correlationId: opts.correlationId,
    };
  }

  async getRunStatus(runId: string): Promise<RunStatusView> {
    const r = this.resultFor(this.runs.get(runId) ?? {});
    return { jobId: runId, runId, status: r.rejected ? 'failed' : 'completed', timeline: { acceptedAtMs: 0, terminalAtMs: 1 } };
  }

  async getRunResult(runId: string): Promise<RunResultView> {
    const r = this.resultFor(this.runs.get(runId) ?? {});
    if (r.rejected) {
      return {
        ok: true, kind: 'status',
        view: { jobId: runId, runId, status: 'failed', timeline: { acceptedAtMs: 0, terminalAtMs: 1 }, terminalCode: 'engine_rejected' },
      };
    }
    return {
      ok: true, kind: 'summary',
      summary: {
        runId, status: 'completed', runKind: 'baseline-only', validationIssues: [],
        metrics: {
          pnl: 100, sharpe: r.sharpe ?? 1, max_drawdown: 0.1, win_rate: 0.5,
          total_trades: r.totalTrades, profit_factor: 1.2, top_trade_contribution_pct: 10,
        },
        coverage: [], artifactRefs: [], evidence: { seed: 0, contractVersion: 'v1', moduleVersions: [] },
      },
    };
  }
}

/** ResultInterpreterPort that always extends, regardless of the round's top-N. */
class AlwaysExtendInterpreter implements ResultInterpreterPort {
  readonly adapter = 'fake' as const;
  readonly model = 'fake';
  async interpret(_input: InterpretInput): Promise<ResultInterpretOutput> { return { decision: 'extend' }; }
}

async function seedBaseline(opts: {
  experiments: InMemoryResearchExperimentRepository;
  strategyBacktests: InMemoryStrategyBacktestRunRepository;
  totalTrades: number;
  boundary: HoldoutBoundary;
}): Promise<string> {
  const experimentId = `baseline-${randomUUID()}`;
  const strategyBacktestRunId = `sbr-${randomUUID()}`;
  await opts.strategyBacktests.createSubmitted({
    id: strategyBacktestRunId, strategyProfileId: 'p1', strategyBundleId: 'sb-wfo',
    bundleHash: BUNDLE_HASH, paramsHash: 'baseline-hash', runKind: STRATEGY_RUN_KIND,
    platformRunId: 'plat-baseline', correlationId: 'sanity', taskId: 'baseline-task',
    params: {}, status: 'submitted', metrics: null,
    platformRun: { ...RUN_CONFIG, period: DATASET_SCOPE.period },
    artifactRefs: [], platformContractVersion: 'pending', sdkContractVersion: '1', backend: 'research_platform',
    submittedAt: NOW, finishedAt: null, createdAt: NOW, updatedAt: NOW,
  });
  await opts.strategyBacktests.markCompleted(strategyBacktestRunId, {
    metrics: metrics({ totalTrades: opts.totalTrades, profitFactor: 1.2, sharpe: 1 }),
    artifactRefs: [], platformContractVersion: 'v1', finishedAt: NOW,
  });
  await opts.experiments.createExperiment({
    id: experimentId, experimentKey: `baseline-key-${experimentId}`, experimentType: 'strategy_baseline_validation',
    strategyProfileId: 'p1', bundleHash: BUNDLE_HASH, datasetScope: DATASET_SCOPE,
    holdoutPolicy: DEFAULT_HOLDOUT_POLICY, holdoutBoundary: opts.boundary, status: 'completed',
    verdict: 'PAPER_CANDIDATE', createdAt: NOW, updatedAt: NOW, completedAt: NOW,
  });
  await opts.experiments.addMember({
    id: `mem-${randomUUID()}`, experimentId, role: 'sanity',
    periodFrom: DATASET_SCOPE.period.from, periodTo: DATASET_SCOPE.period.to, symbols: [...DATASET_SCOPE.symbols],
    paramsHash: '', bundleHash: BUNDLE_HASH, strategyBacktestRunId, tradeCount: opts.totalTrades, createdAt: NOW,
  });
  return experimentId;
}

function buildSvc(opts: {
  resultFor: ResultForFn;
  resultInterpreter?: ResultInterpreterPort;
  wfoBudget?: Partial<WfoBudget>;
}): { svc: ExperimentService; experiments: InMemoryResearchExperimentRepository; strategyBacktests: InMemoryStrategyBacktestRunRepository } {
  const experiments = new InMemoryResearchExperimentRepository();
  const strategyBacktests = new InMemoryStrategyBacktestRunRepository();
  const platform = new FakeWfoPlatform(opts.resultFor);
  const strategyRunExecutor = new BacktesterStrategyExperimentRunExecutor({
    platform, strategyBacktests, poll: { maxPolls: 3, pollDelayMs: 0 }, now: () => NOW,
  });
  const paramGridRunner = new ParamGridRunner({ strategyRunExecutor });
  let counter = 0;
  const svc = new ExperimentService({
    experiments,
    runTrades: new FakeRunTradesAdapter({}),
    runExecutor: { execute: async () => { throw new Error('overlay runExecutor must not be called from WFO'); } },
    strategyRunExecutor,
    newId: (p) => `${p}-${++counter}`,
    now: () => NOW,
    events: { append: async () => {}, listByTask: async () => [] },
    gate1: new FakeGate1(),
    sweepDesigner: new FakeSweepDesigner(),
    resultInterpreter: opts.resultInterpreter ?? new FakeResultInterpreter(),
    paramGridRunner,
    strategyBacktests,
    wfoBudget: { ...DEFAULT_WFO_BUDGET, ...opts.wfoBudget },
  });
  return { svc, experiments, strategyBacktests };
}

function baseInput(baselineExperimentId: string, params: StrategyParameter[], over: Partial<RunWfoInput> = {}): RunWfoInput {
  return {
    baselineExperimentId, strategyBundle: bundle(), profile: profile(params),
    strategyProfileId: 'p1', datasetScope: DATASET_SCOPE, runConfig: RUN_CONFIG,
    metrics: ['netPnlUsd', 'profitFactor', 'sharpe'], taskId: 'wfo-task',
    ...over,
  };
}

const ENTRY_PARAM: StrategyParameter = { name: 'dump.minDropPct', value: 2, unit: '%', description: 'entry filter', tunable: true };
const EXIT_ONLY_PARAMS: StrategyParameter[] = [
  { name: 'risk.hardStopPct', value: 5, unit: '%', description: 'hard stop', tunable: true },
  { name: 'exit.tpLadder', value: 1, unit: '%', description: 'take profit ladder', tunable: true },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('runWalkForwardOptimization', () => {
  it('runs GATE1 → sweep → train grid → select → OOS → verdict; ledgers EVERY grid point', async () => {
    const { svc, experiments, strategyBacktests } = buildSvc({ resultFor: () => ({ totalTrades: 5 }) });
    const baselineExperimentId = await seedBaseline({
      experiments, strategyBacktests, totalTrades: 5,
      boundary: { mode: 'trade_based', t: T, lowConfidence: false, trainTrades: 60, holdoutTrades: 30, reason: 'ok' },
    });
    const input = baseInput(baselineExperimentId, [ENTRY_PARAM]);

    const { experimentId, verdict } = await svc.runWalkForwardOptimization(input);
    const members = await experiments.listMembers(experimentId);
    const train = members.filter((m) => m.role === 'train' && m.oos === false);
    const oos = members.filter((m) => m.role === 'holdout' && m.oos === true);

    expect(train.length).toBe(2); // FakeSweepDesigner grid over 1 tunable param → [base*0.5, base*1.5]
    expect(train.every((m) => m.params !== undefined && m.paramsHash.length > 0)).toBe(true);
    expect(oos.length).toBe(1);
    expect(['PAPER_CANDIDATE', 'FAIL']).toContain(verdict);
  });

  it('a rejected train point still becomes an oos:false member', async () => {
    const { svc, experiments, strategyBacktests } = buildSvc({
      resultFor: (params) => (params['dump.minDropPct'] === 3 ? { rejected: true, totalTrades: 0 } : { totalTrades: 5 }),
    });
    const baselineExperimentId = await seedBaseline({
      experiments, strategyBacktests, totalTrades: 5,
      boundary: { mode: 'trade_based', t: T, lowConfidence: false, trainTrades: 60, holdoutTrades: 30, reason: 'ok' },
    });
    const input = baseInput(baselineExperimentId, [ENTRY_PARAM]);

    const { experimentId } = await svc.runWalkForwardOptimization(input);
    const members = await experiments.listMembers(experimentId);
    const rejected = members.find((m) => m.role === 'train' && m.oos === false && (m.params as Record<string, unknown> | undefined)?.['dump.minDropPct'] === 3);

    expect(rejected).toBeDefined();
    expect(rejected?.tradeCount).toBeUndefined();
    expect(rejected?.paramsHash.length).toBeGreaterThan(0);
  });

  it("mode:none boundary → INCONCLUSIVE, no OOS member", async () => {
    const { svc, experiments, strategyBacktests } = buildSvc({ resultFor: () => ({ totalTrades: 5 }) });
    const baselineExperimentId = await seedBaseline({
      experiments, strategyBacktests, totalTrades: 5,
      boundary: { mode: 'none', lowConfidence: true, reason: 'insufficient_history' },
    });
    const input = baseInput(baselineExperimentId, [ENTRY_PARAM]);

    const { experimentId, verdict, terminalReason } = await svc.runWalkForwardOptimization(input);
    const members = await experiments.listMembers(experimentId);

    expect(verdict).toBe('INCONCLUSIVE');
    expect(terminalReason).toBe('inconclusive');
    expect(members.filter((m) => m.oos === true).length).toBe(0);
  });

  it('GATE1 stop_insufficient_evidence (0-trade baseline, exit-only tunables) → no sweep, no train members', async () => {
    const { svc, experiments, strategyBacktests } = buildSvc({ resultFor: () => ({ totalTrades: 5 }) });
    const baselineExperimentId = await seedBaseline({
      experiments, strategyBacktests, totalTrades: 0,
      boundary: { mode: 'trade_based', t: T, lowConfidence: false, trainTrades: 60, holdoutTrades: 30, reason: 'ok' },
    });
    const input = baseInput(baselineExperimentId, EXIT_ONLY_PARAMS, { entrySignalEvidence: false });

    const { experimentId, verdict, terminalReason } = await svc.runWalkForwardOptimization(input);
    const members = await experiments.listMembers(experimentId);

    expect(verdict).toBe('INCONCLUSIVE');
    expect(terminalReason).toBe('stop_insufficient_evidence');
    expect(members.length).toBe(0);
  });

  it('empty top-N → sweep_failed', async () => {
    const { svc, experiments, strategyBacktests } = buildSvc({ resultFor: () => ({ totalTrades: 0 }) });
    const baselineExperimentId = await seedBaseline({
      experiments, strategyBacktests, totalTrades: 5,
      boundary: { mode: 'trade_based', t: T, lowConfidence: false, trainTrades: 60, holdoutTrades: 30, reason: 'ok' },
    });
    const input = baseInput(baselineExperimentId, [ENTRY_PARAM]);

    const { experimentId, verdict, terminalReason } = await svc.runWalkForwardOptimization(input);
    const members = await experiments.listMembers(experimentId);
    const train = members.filter((m) => m.role === 'train' && m.oos === false);

    expect(verdict).toBe('INCONCLUSIVE');
    expect(terminalReason).toBe('sweep_failed');
    expect(train.length).toBe(2);
    expect(members.filter((m) => m.oos === true).length).toBe(0);
  });

  it('interpreter always extend beyond maxRounds → round_limit_reached', async () => {
    const { svc, experiments, strategyBacktests } = buildSvc({
      resultFor: () => ({ totalTrades: 5 }),
      resultInterpreter: new AlwaysExtendInterpreter(),
      wfoBudget: { maxRounds: 1 },
    });
    const baselineExperimentId = await seedBaseline({
      experiments, strategyBacktests, totalTrades: 5,
      boundary: { mode: 'trade_based', t: T, lowConfidence: false, trainTrades: 60, holdoutTrades: 30, reason: 'ok' },
    });
    const input = baseInput(baselineExperimentId, [ENTRY_PARAM]);

    const { verdict, terminalReason } = await svc.runWalkForwardOptimization(input);

    expect(verdict).toBe('INCONCLUSIVE');
    expect(terminalReason).toBe('round_limit_reached');
  });
});
