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
import type {
  ResultInterpreterPort, InterpretInput, SweepDesignerPort, SweepInput, Gate1DecisionPort,
} from '../ports/wfo-agents.port.ts';
import type { ResultInterpretOutput, SweepDesignOutput } from '../domain/wfo.ts';
import type { AgentCallOpts } from '../ports/agent-call-opts.ts';
import type { TokenUsageRepository } from '../ports/token-usage.repository.ts';
import { InMemoryResearchExperimentRepository } from '../adapters/repository/in-memory-research-experiment.repository.ts';
import { InMemoryStrategyBacktestRunRepository } from '../adapters/repository/in-memory-strategy-backtest-run.repository.ts';
import { InMemoryTokenUsageRepository } from '../adapters/repository/in-memory-token-usage.repository.ts';
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
import { computeStrategyParamsHash } from './strategy-run-identity.ts';
import { encodeTrainPeriod } from './period-encoding.ts';

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

/**
 * ResultInterpreterPort that always "selects" a fixed paramsHash, regardless of what it was
 * actually shown in topN. Used to simulate a hallucinated/out-of-band chosenParamsHash that
 * matches a point present in allResults (e.g. a rejected/zero-trade point) but absent from
 * the top-N ranked list the interpreter was given.
 */
class FixedHashInterpreter implements ResultInterpreterPort {
  readonly adapter = 'fake' as const;
  readonly model = 'fake';
  private readonly hash: string;
  constructor(hash: string) { this.hash = hash; }
  async interpret(_input: InterpretInput): Promise<ResultInterpretOutput> {
    return { decision: 'select', chosenParamsHash: this.hash };
  }
}

/** SweepDesignerPort fake that returns a caller-supplied (possibly invalid) grid verbatim. */
class BadSweepDesigner implements SweepDesignerPort {
  readonly adapter = 'fake' as const;
  readonly model = 'fake';
  private readonly grid: Record<string, unknown[]>;
  constructor(grid: Record<string, unknown[]>) { this.grid = grid; }
  async design(_input: SweepInput): Promise<SweepDesignOutput> {
    return { grid: this.grid, rationale: 'bad designer — returns whatever grid it was given' };
  }
}

/**
 * SweepDesignerPort wrapper that delegates to a real FakeSweepDesigner but also invokes a
 * caller-supplied `bump` side effect on every call — used to simulate a token-usage bump that
 * lands in the correlationId's cumulative counter WITHOUT going through opts.onUsage (the
 * budget-gate test drives `tokenUsage.get` off a plain closure variable, not the repository).
 */
class BumpingSweepDesigner implements SweepDesignerPort {
  readonly adapter = 'fake' as const;
  readonly model = 'fake';
  readonly calls: SweepInput[] = [];
  private readonly inner = new FakeSweepDesigner();
  private readonly bump: () => void;
  constructor(bump: () => void) { this.bump = bump; }
  async design(input: SweepInput, opts?: AgentCallOpts): Promise<SweepDesignOutput> {
    this.calls.push(input);
    this.bump();
    return this.inner.design(input, opts);
  }
}

async function seedBaseline(opts: {
  experiments: InMemoryResearchExperimentRepository;
  strategyBacktests: InMemoryStrategyBacktestRunRepository;
  totalTrades: number;
  boundary: HoldoutBoundary;
  // Optional TRAIN-window totalTrades, defaults to mirroring `totalTrades` so pre-existing
  // trade_based-boundary tests keep their original GATE1/hasEntrySignalEvidence behavior. Pass
  // explicitly to simulate a train window whose metrics diverge from the sanity/full-period run
  // (no-leakage regression coverage — see runWalkForwardOptimization).
  trainTotalTrades?: number;
  // Embargo-test hook: extra keys merged into the persisted TRAIN metrics (the
  // agent-facing block), simulating an SDK/mapper widening. Default: none.
  trainMetricsExtras?: Record<string, unknown>;
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

  // TRAIN member: the agent-facing baseline metrics source whenever a valid split exists.
  if (opts.boundary.mode !== 'none') {
    const trainTotalTrades = opts.trainTotalTrades ?? opts.totalTrades;
    const trainRunId = `sbr-train-${randomUUID()}`;
    const trainPeriod = encodeTrainPeriod(DATASET_SCOPE.period.from, opts.boundary.t ?? DATASET_SCOPE.period.to, RUN_CONFIG.timeframe);
    await opts.strategyBacktests.createSubmitted({
      id: trainRunId, strategyProfileId: 'p1', strategyBundleId: 'sb-wfo',
      bundleHash: BUNDLE_HASH, paramsHash: 'baseline-train-hash', runKind: STRATEGY_RUN_KIND,
      platformRunId: 'plat-baseline-train', correlationId: 'train', taskId: 'baseline-task',
      params: {}, status: 'submitted', metrics: null,
      platformRun: { ...RUN_CONFIG, period: trainPeriod },
      artifactRefs: [], platformContractVersion: 'pending', sdkContractVersion: '1', backend: 'research_platform',
      submittedAt: NOW, finishedAt: null, createdAt: NOW, updatedAt: NOW,
    });
    await opts.strategyBacktests.markCompleted(trainRunId, {
      metrics: {
        ...metrics({ totalTrades: trainTotalTrades, profitFactor: 1.2, sharpe: 2 }),
        ...(opts.trainMetricsExtras ?? {}),
      } as never,
      artifactRefs: [], platformContractVersion: 'v1', finishedAt: NOW,
    });
    await opts.experiments.addMember({
      id: `mem-${randomUUID()}`, experimentId, role: 'train',
      periodFrom: trainPeriod.from, periodTo: trainPeriod.to, symbols: [...DATASET_SCOPE.symbols],
      paramsHash: '', bundleHash: BUNDLE_HASH, strategyBacktestRunId: trainRunId, tradeCount: trainTotalTrades, createdAt: NOW,
    });
  }

  return experimentId;
}

function buildSvc(opts: {
  resultFor: ResultForFn;
  resultInterpreter?: ResultInterpreterPort;
  sweepDesigner?: SweepDesignerPort;
  gate1?: Gate1DecisionPort;
  wfoBudget?: Partial<WfoBudget>;
  tokenUsage?: Pick<TokenUsageRepository, 'get'>;
  researchTaskTokenBudget?: number;
  events?: { append: (e: unknown) => Promise<void>; listByTask: () => Promise<never[]> };
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
    events: (opts.events ?? { append: async () => {}, listByTask: async () => [] }) as never,
    gate1: opts.gate1 ?? new FakeGate1(),
    sweepDesigner: opts.sweepDesigner ?? new FakeSweepDesigner(),
    resultInterpreter: opts.resultInterpreter ?? new FakeResultInterpreter(),
    paramGridRunner,
    strategyBacktests,
    wfoBudget: { ...DEFAULT_WFO_BUDGET, ...opts.wfoBudget },
    tokenUsage: opts.tokenUsage,
    researchTaskTokenBudget: opts.researchTaskTokenBudget,
  });
  return { svc, experiments, strategyBacktests };
}

function baseInput(baselineExperimentId: string, params: StrategyParameter[], over: Partial<RunWfoInput> = {}): RunWfoInput {
  return {
    baselineExperimentId, strategyBundle: bundle(), profile: profile(params),
    strategyProfileId: 'p1', datasetScope: DATASET_SCOPE, runConfig: RUN_CONFIG,
    metrics: ['netPnlUsd', 'profitFactor', 'sharpe'], taskId: 'wfo-task',
    correlationId: 'test-corr',
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

  it('chosenParamsHash matching only a rejected/zero-trade point (not in top-N) → sweep_failed, no oos member', async () => {
    // dump.minDropPct=3 → rejected/zero-trade (present in allResults, excluded from ranked by rankTopN).
    const { svc, experiments, strategyBacktests } = buildSvc({
      resultFor: (params) => (params['dump.minDropPct'] === 3 ? { rejected: true, totalTrades: 0 } : { totalTrades: 5 }),
      resultInterpreter: new FixedHashInterpreter(
        computeStrategyParamsHash({
          bundleHash: BUNDLE_HASH,
          platformRun: { ...RUN_CONFIG, period: encodeTrainPeriod(DATASET_SCOPE.period.from, T, RUN_CONFIG.timeframe) },
          params: { 'dump.minDropPct': 3 },
        }),
      ),
    });
    const baselineExperimentId = await seedBaseline({
      experiments, strategyBacktests, totalTrades: 5,
      boundary: { mode: 'trade_based', t: T, lowConfidence: false, trainTrades: 60, holdoutTrades: 30, reason: 'ok' },
    });
    const input = baseInput(baselineExperimentId, [ENTRY_PARAM]);

    const { experimentId, verdict, terminalReason } = await svc.runWalkForwardOptimization(input);
    const members = await experiments.listMembers(experimentId);

    expect(verdict).toBe('INCONCLUSIVE');
    expect(terminalReason).toBe('sweep_failed');
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

  it('SweepDesigner returns a key that is not a tunable param of the profile → grid_invalid, no train members, no oos member', async () => {
    const { svc, experiments, strategyBacktests } = buildSvc({
      resultFor: () => ({ totalTrades: 5 }),
      sweepDesigner: new BadSweepDesigner({ 'unknown.param': [1, 2] }),
    });
    const baselineExperimentId = await seedBaseline({
      experiments, strategyBacktests, totalTrades: 5,
      boundary: { mode: 'trade_based', t: T, lowConfidence: false, trainTrades: 60, holdoutTrades: 30, reason: 'ok' },
    });
    const input = baseInput(baselineExperimentId, [ENTRY_PARAM]);

    const { experimentId, verdict, terminalReason } = await svc.runWalkForwardOptimization(input);
    const members = await experiments.listMembers(experimentId);

    expect(verdict).toBe('INCONCLUSIVE');
    expect(terminalReason).toBe('grid_invalid');
    expect(members.filter((m) => m.role === 'train' && m.oos === false).length).toBe(0);
    expect(members.filter((m) => m.oos === true).length).toBe(0);
  });

  it('SweepDesigner returns an exit-only key while GATE1 restricts the exploratory sweep to entry-affecting params → grid_invalid', async () => {
    const { svc, experiments, strategyBacktests } = buildSvc({
      resultFor: () => ({ totalTrades: 5 }),
      sweepDesigner: new BadSweepDesigner({ 'risk.hardStopPct': [1, 2] }),
    });
    const baselineExperimentId = await seedBaseline({
      experiments, strategyBacktests, totalTrades: 0,
      boundary: { mode: 'trade_based', t: T, lowConfidence: false, trainTrades: 60, holdoutTrades: 30, reason: 'ok' },
    });
    const input = baseInput(
      baselineExperimentId,
      [ENTRY_PARAM, ...EXIT_ONLY_PARAMS],
      { entrySignalEvidence: true },
    );

    const { experimentId, verdict, terminalReason } = await svc.runWalkForwardOptimization(input);
    const members = await experiments.listMembers(experimentId);

    expect(verdict).toBe('INCONCLUSIVE');
    expect(terminalReason).toBe('grid_invalid');
    expect(members.filter((m) => m.role === 'train' && m.oos === false).length).toBe(0);
    expect(members.filter((m) => m.oos === true).length).toBe(0);
  });

  it('no-leakage regression: agents see the TRAIN-window baseline metrics, not the sanity/full-period ones', async () => {
    // Sanity/full-period run looks GOOD (20 trades) — if that leaked into GATE1, FakeGate1 would
    // pick 'improve' (its `baselineMetrics.totalTrades >= 1` branch). The TRAIN-window run is a
    // 0-trade run — the correct agent-facing signal for a valid split. With totalTrades:0 and
    // entrySignalEvidence left unset, FakeGate1 must fall through entry-affecting-but-no-evidence
    // to 'stop_insufficient_evidence', proving GATE1 saw the TRAIN metrics, not the sanity ones.
    const { svc, experiments, strategyBacktests } = buildSvc({ resultFor: () => ({ totalTrades: 5 }) });
    const baselineExperimentId = await seedBaseline({
      experiments, strategyBacktests, totalTrades: 20, trainTotalTrades: 0,
      boundary: { mode: 'trade_based', t: T, lowConfidence: false, trainTrades: 60, holdoutTrades: 30, reason: 'ok' },
    });
    const input = baseInput(baselineExperimentId, [ENTRY_PARAM]);

    const { experimentId, verdict, terminalReason } = await svc.runWalkForwardOptimization(input);
    const members = await experiments.listMembers(experimentId);

    expect(verdict).toBe('INCONCLUSIVE');
    expect(terminalReason).toBe('stop_insufficient_evidence');
    expect(members.length).toBe(0); // GATE1 stopped before any sweep/train round — no leaked 'improve'
  });

  it('bundle-hash mismatch between input.strategyBundle and the baseline experiment throws before any round runs', async () => {
    const { svc, experiments, strategyBacktests } = buildSvc({ resultFor: () => ({ totalTrades: 5 }) });
    const baselineExperimentId = await seedBaseline({
      experiments, strategyBacktests, totalTrades: 5,
      boundary: { mode: 'trade_based', t: T, lowConfidence: false, trainTrades: 60, holdoutTrades: 30, reason: 'ok' },
    });
    const input = baseInput(baselineExperimentId, [ENTRY_PARAM], {
      strategyBundle: { ...bundle(), bundleHash: 'sha256:different-rebuilt-bundle' },
    });

    await expect(svc.runWalkForwardOptimization(input)).rejects.toThrow(/bundle mismatch/);
  });

  it('stops with budget_exhausted before GATE1 when the correlation budget is spent', async () => {
    const gate1 = new FakeGate1();
    const { svc, experiments, strategyBacktests } = buildSvc({
      resultFor: () => ({ totalTrades: 5 }),
      gate1,
      tokenUsage: { get: async () => 1_000_000 },
      researchTaskTokenBudget: 500_000,
    });
    const baselineExperimentId = await seedBaseline({
      experiments, strategyBacktests, totalTrades: 5,
      boundary: { mode: 'trade_based', t: T, lowConfidence: false, trainTrades: 60, holdoutTrades: 30, reason: 'ok' },
    });
    const input = baseInput(baselineExperimentId, [ENTRY_PARAM], { correlationId: 'corr-1' });

    const { verdict, terminalReason } = await svc.runWalkForwardOptimization(input);

    expect(verdict).toBe('INCONCLUSIVE');
    expect(terminalReason).toBe('budget_exhausted');
    expect(gate1.calls).toHaveLength(0);
  });

  it('stops the round loop between rounds when the budget runs out mid-experiment', async () => {
    let cumulative = 0;
    const sweepDesigner = new BumpingSweepDesigner(() => { cumulative = 200; });
    const { svc, experiments, strategyBacktests } = buildSvc({
      resultFor: () => ({ totalTrades: 5 }),
      sweepDesigner,
      resultInterpreter: new AlwaysExtendInterpreter(),
      tokenUsage: { get: async () => cumulative },
      researchTaskTokenBudget: 100,
    });
    const baselineExperimentId = await seedBaseline({
      experiments, strategyBacktests, totalTrades: 5,
      boundary: { mode: 'trade_based', t: T, lowConfidence: false, trainTrades: 60, holdoutTrades: 30, reason: 'ok' },
    });
    const input = baseInput(baselineExperimentId, [ENTRY_PARAM], { correlationId: 'corr-2' });

    // round 1 runs (sweepDesigner bumps cumulative past the budget); before round 2's
    // sweepDesigner call the gate trips and the loop stops without a second design call.
    const { terminalReason } = await svc.runWalkForwardOptimization(input);

    expect(terminalReason).toBe('budget_exhausted');
    expect(sweepDesigner.calls).toHaveLength(1);
  });

  it('budget gate reads the same correlationId that onUsage writes (key-consistency regression)', async () => {
    // Regression guard: the WFO budget gate MUST check the same correlationId that agentOpts.onUsage
    // charges usage against — through a REAL InMemoryTokenUsageRepository, not a closure variable
    // standing in for it (see the "stops the round loop..." test above, which intentionally drives
    // tokenUsage.get off a plain `cumulative` closure — the anti-pattern this test proves is absent
    // from the real write→read path). FakeGate1/FakeSweepDesigner/FakeResultInterpreter all invoke
    // opts?.onUsage(...) when given (see fake-gate1.ts/fake-sweep-designer.ts), but as test doubles
    // that never call a real LLM they report a fixed zero-token AgentCallUsage payload. To exercise
    // the repository write path end-to-end we mirror src/orchestrator/make-on-usage.ts's shape
    // (onUsage -> tokenUsage.add(correlationId, tokens)) but attribute a representative per-call
    // token cost, since forwarding the fakes' literal zero would never trip the budget.
    const tokenUsageRepo = new InMemoryTokenUsageRepository();
    const correlationId = 'corr-key';
    const agentOpts: AgentCallOpts = {
      onUsage: async () => { await tokenUsageRepo.add(correlationId, 300); },
    };
    const { svc, experiments, strategyBacktests } = buildSvc({
      resultFor: () => ({ totalTrades: 5 }),
      resultInterpreter: new AlwaysExtendInterpreter(), // forces round 2 so the mid-loop gate is reached
      tokenUsage: tokenUsageRepo,
      researchTaskTokenBudget: 500, // survives GATE1 (300) but round 1's GATE1+sweepDesigner usage (600) trips it
    });
    const baselineExperimentId = await seedBaseline({
      experiments, strategyBacktests, totalTrades: 5,
      boundary: { mode: 'trade_based', t: T, lowConfidence: false, trainTrades: 60, holdoutTrades: 30, reason: 'ok' },
    });
    const input = baseInput(baselineExperimentId, [ENTRY_PARAM], { correlationId, agentOpts });

    const { terminalReason } = await svc.runWalkForwardOptimization(input);

    expect(terminalReason).toBe('budget_exhausted');
    // Proves the gate's read (tokenUsage.get(correlationId)) actually observed the tokens
    // onUsage wrote (tokenUsage.add(correlationId, ...)) under the identical key — no shortcut.
    expect(await tokenUsageRepo.get(correlationId)).toBeGreaterThan(0);
  });

  it('forwards agentOpts to gate1/sweepDesigner/resultInterpreter calls', async () => {
    const seen: string[] = [];
    const agentOpts: AgentCallOpts = { onUsage: async () => { seen.push('usage'); } };
    const { svc, experiments, strategyBacktests } = buildSvc({ resultFor: () => ({ totalTrades: 5 }) });
    const baselineExperimentId = await seedBaseline({
      experiments, strategyBacktests, totalTrades: 5,
      boundary: { mode: 'trade_based', t: T, lowConfidence: false, trainTrades: 60, holdoutTrades: 30, reason: 'ok' },
    });
    const input = baseInput(baselineExperimentId, [ENTRY_PARAM], { correlationId: 'corr-3', agentOpts });

    await svc.runWalkForwardOptimization(input);

    // gate1.decide + sweepDesigner.design + resultInterpreter.interpret each report usage.
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });
});

describe('outcome embargo (S1)', () => {
  it('scrubs embargoed metric keys from gate1/sweep inputs, emits scrubbed events, keeps train metrics', async () => {
    const gate1 = new FakeGate1();
    const sweepDesigner = new FakeSweepDesigner();
    const appended: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const { svc, experiments, strategyBacktests } = buildSvc({
      resultFor: () => ({ totalTrades: 5 }),
      gate1, sweepDesigner,
      events: { append: async (e) => { appended.push(e as { type: string; payload: Record<string, unknown> }); }, listByTask: async () => [] },
    });
    const baselineExperimentId = await seedBaseline({
      experiments, strategyBacktests, totalTrades: 5,
      boundary: { mode: 'trade_based', t: T, lowConfidence: false, trainTrades: 60, holdoutTrades: 30, reason: 'ok' },
      trainMetricsExtras: {
        holdoutSharpe: 9.99,
        promotion: { verdict: 'passed' },
        outOfSampleNetPnl: 123.45,
        evaluationWindow: { from: '2031-12-31T00:00:00.000Z', to: '2031-12-31T23:59:59.000Z' },
      },
    });

    const input = baseInput(baselineExperimentId, [ENTRY_PARAM]);
    await svc.runWalkForwardOptimization(input);

    // No embargo keys or sentinel values in ANY captured LLM port input:
    const captured = JSON.stringify({ gate1: gate1.calls, sweep: sweepDesigner.calls });
    expect(captured).not.toContain('holdoutSharpe');
    expect(captured).not.toContain('promotion');
    expect(captured).not.toContain('outOfSample');
    expect(captured).not.toContain('evaluationWindow');
    expect(captured).not.toContain('9.99');
    expect(captured).not.toContain('123.45');
    expect(captured).not.toContain('2031-12-31');
    // Boundary date T absent from port inputs (periodTo removed in Task 3):
    expect(captured).not.toContain(T);
    // Positive control — train metrics survive the scrub:
    expect(gate1.calls[0]!.baselineMetrics.totalTrades).toBe(5);
    expect(sweepDesigner.calls[0]!.baselineTrainSummary.sharpe).toBeDefined();
    // Scrub evidence event, names only:
    const scrubEvents = appended.filter((e) => e.type === 'outcome_embargo.scrubbed');
    expect(scrubEvents.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(scrubEvents)).not.toContain('9.99');
    expect(JSON.stringify(scrubEvents)).not.toContain('2031-12-31');
    expect(scrubEvents[0]!.payload['site']).toBe('wfo.gate1.baselineMetrics');
    expect(scrubEvents[0]!.payload['removedKeys']).toEqual(
      expect.arrayContaining(['holdoutSharpe', 'promotion', 'outOfSampleNetPnl', 'evaluationWindow']),
    );
  });
});
