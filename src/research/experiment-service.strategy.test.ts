// src/research/experiment-service.strategy.test.ts
import { describe, it, expect } from 'vitest';
import { ExperimentService } from './experiment-service.ts';
import type { RunStrategyBaselineValidationInput } from './experiment-service.ts';
import type {
  StrategyExperimentRunExecutor, StrategyExperimentRunRequest, StrategyExperimentRunResult,
} from './strategy-experiment-run-executor.ts';
import type { ExperimentRunExecutor, ExperimentRunRequest, ExperimentRunResult } from './experiment-run-executor.ts';
import type { MemberRole, TradeRecord } from '../domain/research-experiment.ts';
import type { AssembledStrategyBundle } from '../domain/strategy-bundle.ts';
import { InMemoryResearchExperimentRepository } from '../adapters/repository/in-memory-research-experiment.repository.ts';
import { FakeRunTradesAdapter } from '../adapters/platform/fake-run-trades.adapter.ts';
import { ParamGridRunner } from './param-grid-runner.ts';
import { FakeGate1 } from '../adapters/wfo/fake-gate1.ts';
import { FakeSweepDesigner } from '../adapters/wfo/fake-sweep-designer.ts';
import { FakeResultInterpreter } from '../adapters/wfo/fake-result-interpreter.ts';
import { InMemoryStrategyBacktestRunRepository } from '../adapters/repository/in-memory-strategy-backtest-run.repository.ts';
import type { ArtifactRef } from '../domain/types.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const DAY = 86_400_000;
const START = Date.parse('2023-01-01T00:00:00.000Z');

function trades(n: number): TradeRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    entryTs: START + i * DAY,
    exitTs: START + i * DAY + 3_600_000,
    side: 'long' as const,
    realizedPnl: 1,
  }));
}

function strategyBundle(): AssembledStrategyBundle {
  return {
    bytes: new Uint8Array(),
    source: 'export default {};',
    manifest: { id: 'sb-1' } as never,
    bundleHash: 'sha256:bundle',
  };
}

const RUN_CONFIG = { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', seed: 7 };

function baseInput(over: Partial<RunStrategyBaselineValidationInput> = {}): RunStrategyBaselineValidationInput {
  return {
    strategyProfileId: 'p1',
    strategyBundle: strategyBundle(),
    datasetScope: { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2023-01-01', to: '2023-06-30' } },
    runConfig: RUN_CONFIG,
    metrics: ['netPnlUsd', 'profitFactor', 'sharpe'],
    taskId: 't1',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------
class FakeStrategyExecutor implements StrategyExperimentRunExecutor {
  public readonly calls: MemberRole[] = [];
  constructor(private readonly resultFor: (role: MemberRole) => StrategyExperimentRunResult) {}
  async execute(req: StrategyExperimentRunRequest): Promise<StrategyExperimentRunResult> {
    this.calls.push(req.role);
    return this.resultFor(req.role);
  }
}

/** Overlay dep is required by ExperimentServiceDeps but unused in the strategy-baseline flow — must never be called. */
class NeverOverlayExecutor implements ExperimentRunExecutor {
  async execute(_req: ExperimentRunRequest): Promise<ExperimentRunResult> {
    throw new Error('overlay runExecutor must not be called from runStrategyBaselineValidation');
  }
}

function testArtifactRef(): ArtifactRef {
  return {
    artifact_id: 'art-1', uri: 'file:///tmp/a.json', content_hash: 'sha256:aa',
    kind: 'strategy_bundle', size_bytes: 10, mime_type: 'application/json',
    created_at: '2026-07-03T00:00:00.000Z', producer: 'test', metadata: {},
  };
}

function viableHoldoutMetrics() {
  return {
    netPnlUsd: 500, netPnlPct: 5, totalTrades: 30, winRate: 0.6, profitFactor: 1.5,
    maxDrawdownPct: 8, expectancyUsd: 16.6, sharpe: 1.2, topTradeContributionPct: 10,
  };
}

function buildSvc(
  resultFor: (role: MemberRole) => StrategyExperimentRunResult,
  tradesByRun: Record<string, TradeRecord[]>,
): { svc: ExperimentService; experiments: InMemoryResearchExperimentRepository; executor: FakeStrategyExecutor } {
  const experiments = new InMemoryResearchExperimentRepository();
  const runTrades = new FakeRunTradesAdapter(tradesByRun);
  const executor = new FakeStrategyExecutor(resultFor);
  let counter = 0;
  const svc = new ExperimentService({
    experiments,
    runTrades,
    runExecutor: new NeverOverlayExecutor(),
    strategyRunExecutor: executor,
    newId: (p) => `${p}-${++counter}`,
    now: () => '2026-01-01T00:00:00.000Z',
    events: { append: async () => {}, listByTask: async () => [] },
    gate1: new FakeGate1(),
    sweepDesigner: new FakeSweepDesigner(),
    resultInterpreter: new FakeResultInterpreter(),
    paramGridRunner: new ParamGridRunner({ strategyRunExecutor: executor }),
    strategyBacktests: new InMemoryStrategyBacktestRunRepository(),
  });
  return { svc, experiments, executor };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('runStrategyBaselineValidation', () => {
  it('few trades over a short slice → INCONCLUSIVE, no train/holdout runs (demo path)', async () => {
    const { svc, experiments, executor } = buildSvc(
      () => ({ status: 'completed', runId: 'r-sanity', platformRunId: 'plat-sanity', totalTrades: 4 }),
      { 'plat-sanity': trades(4) },
    );

    const input = baseInput({
      datasetScope: { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2023-01-01', to: '2023-01-07' } },
    });
    const { experimentId, verdict } = await svc.runStrategyBaselineValidation(input);

    expect(verdict).toBe('INCONCLUSIVE');
    expect(executor.calls).toEqual(['sanity']);

    const members = await experiments.listMembers(experimentId);
    expect(members).toHaveLength(1);
    expect(members[0]!.role).toBe('sanity');
    expect(members[0]!.strategyBacktestRunId).toBe('r-sanity');
    expect(members[0]!.backtestRunId).toBeUndefined();

    const exp = await experiments.findById(experimentId);
    expect(exp?.experimentType).toBe('strategy_baseline_validation');
    expect(exp?.hypothesisId).toBeUndefined();
    expect(exp?.buildId).toBeUndefined();
    expect(exp?.bundleHash).toBe('sha256:bundle');
  });

  it('persists bundleArtifactRef on the baseline experiment row', async () => {
    const { svc, experiments } = buildSvc(
      () => ({ status: 'completed', runId: 'r-sanity', platformRunId: 'plat-sanity', totalTrades: 4 }),
      { 'plat-sanity': trades(4) },
    );
    const ref = testArtifactRef();
    const input = baseInput({
      datasetScope: { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2023-01-01', to: '2023-01-07' } },
      bundleArtifactRef: ref,
    });

    const { experimentId } = await svc.runStrategyBaselineValidation(input);

    expect((await experiments.findById(experimentId))?.bundleArtifactRef).toEqual(ref);
  });

  it('backfills bundleArtifactRef onto an existing completed experiment that predates ref persistence', async () => {
    const { svc, experiments, executor } = buildSvc(
      () => ({ status: 'completed', runId: 'r-sanity', platformRunId: 'plat-sanity', totalTrades: 4 }),
      { 'plat-sanity': trades(4) },
    );
    const shortInput = baseInput({
      datasetScope: { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2023-01-01', to: '2023-01-07' } },
    });

    // First run: no bundleArtifactRef supplied (simulates a row created before ref persistence landed).
    const first = await svc.runStrategyBaselineValidation(shortInput);
    expect(first.verdict).toBe('INCONCLUSIVE');
    expect((await experiments.findById(first.experimentId))?.bundleArtifactRef).toBeUndefined();
    expect(executor.calls).toEqual(['sanity']);

    // Second run: same key, now WITH a ref — dedup early-return must backfill it onto the existing row.
    const refA = testArtifactRef();
    const second = await svc.runStrategyBaselineValidation({ ...shortInput, bundleArtifactRef: refA });
    expect(second.experimentId).toBe(first.experimentId);
    expect(second.verdict).toBe('INCONCLUSIVE');
    expect((await experiments.findById(first.experimentId))?.bundleArtifactRef).toEqual(refA);

    // No new member/run was created by the dedup path.
    expect(executor.calls).toEqual(['sanity']);
    expect(await experiments.listMembers(first.experimentId)).toHaveLength(1);

    // Third run: a DIFFERENT ref must NOT overwrite the already-backfilled one (first ref wins).
    const refB: typeof refA = { ...refA, artifact_id: 'art-2', uri: 'file:///tmp/b.json' };
    const third = await svc.runStrategyBaselineValidation({ ...shortInput, bundleArtifactRef: refB });
    expect(third.experimentId).toBe(first.experimentId);
    expect((await experiments.findById(first.experimentId))?.bundleArtifactRef).toEqual(refA);
    expect(executor.calls).toEqual(['sanity']);
  });

  it('synthetic ≥30-trade path with a surviving holdout → PAPER_CANDIDATE', async () => {
    const resultFor = (role: MemberRole): StrategyExperimentRunResult => {
      if (role === 'holdout') {
        return { status: 'completed', runId: 'r-holdout', platformRunId: 'plat-holdout', totalTrades: 30, metrics: viableHoldoutMetrics() };
      }
      if (role === 'train') {
        return { status: 'completed', runId: 'r-train', platformRunId: 'plat-train', totalTrades: 60, metrics: viableHoldoutMetrics() };
      }
      return { status: 'completed', runId: 'r-sanity', platformRunId: 'plat-sanity', totalTrades: 90 };
    };
    const { svc, experiments, executor } = buildSvc(resultFor, { 'plat-sanity': trades(90) });

    const { experimentId, verdict } = await svc.runStrategyBaselineValidation(baseInput());

    expect(verdict).toBe('PAPER_CANDIDATE');
    expect(executor.calls).toEqual(['sanity', 'train', 'holdout']);

    const members = await experiments.listMembers(experimentId);
    expect(members.map((m) => m.role)).toEqual(['sanity', 'train', 'holdout']);
    for (const m of members) {
      expect(m.strategyBacktestRunId).toBeDefined();
      expect(m.backtestRunId).toBeUndefined();
    }

    const exp = await experiments.findById(experimentId);
    expect(exp?.verdict).toBe('PAPER_CANDIDATE');
    expect(exp?.experimentType).toBe('strategy_baseline_validation');
  });

  it('executor throws on sanity → rejects and leaves no dangling member (member XOR invariant)', async () => {
    class ThrowingStrategyExecutor implements StrategyExperimentRunExecutor {
      async execute(_req: StrategyExperimentRunRequest): Promise<StrategyExperimentRunResult> {
        throw new Error('engine unreachable');
      }
    }
    const experiments = new InMemoryResearchExperimentRepository();
    const runTrades = new FakeRunTradesAdapter({});
    let counter = 0;
    const throwingExecutor = new ThrowingStrategyExecutor();
    const svc = new ExperimentService({
      experiments,
      runTrades,
      runExecutor: new NeverOverlayExecutor(),
      strategyRunExecutor: throwingExecutor,
      newId: (p) => `${p}-${++counter}`,
      now: () => '2026-01-01T00:00:00.000Z',
      events: { append: async () => {}, listByTask: async () => [] },
      gate1: new FakeGate1(),
      sweepDesigner: new FakeSweepDesigner(),
      resultInterpreter: new FakeResultInterpreter(),
      paramGridRunner: new ParamGridRunner({ strategyRunExecutor: throwingExecutor }),
      strategyBacktests: new InMemoryStrategyBacktestRunRepository(),
    });

    await expect(svc.runStrategyBaselineValidation(baseInput())).rejects.toThrow('engine unreachable');

    // The experiment row itself is created before the throwing sanity call — real: id 'exp-1'
    // (first newId call). No member must exist referencing neither run id (dangling XOR breach).
    const members = await experiments.listMembers('exp-1');
    expect(members).toHaveLength(0);
  });

  it('submits train and holdout concurrently after the boundary resolves', async () => {
    const entered: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    class TimedStrategyExecutor implements StrategyExperimentRunExecutor {
      async execute(req: StrategyExperimentRunRequest): Promise<StrategyExperimentRunResult> {
        entered.push(req.role);
        if (req.role === 'train' || req.role === 'holdout') {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 10));
          inFlight--;
        }
        if (req.role === 'holdout') {
          return { status: 'completed', runId: 'r-holdout', platformRunId: 'plat-holdout', totalTrades: 30, metrics: viableHoldoutMetrics() };
        }
        if (req.role === 'train') {
          return { status: 'completed', runId: 'r-train', platformRunId: 'plat-train', totalTrades: 60, metrics: viableHoldoutMetrics() };
        }
        return { status: 'completed', runId: 'r-sanity', platformRunId: 'plat-sanity', totalTrades: 90 };
      }
    }

    const experiments = new InMemoryResearchExperimentRepository();
    const runTrades = new FakeRunTradesAdapter({ 'plat-sanity': trades(90) });
    const executor = new TimedStrategyExecutor();
    let counter = 0;
    const svc = new ExperimentService({
      experiments,
      runTrades,
      runExecutor: new NeverOverlayExecutor(),
      strategyRunExecutor: executor,
      newId: (p) => `${p}-${++counter}`,
      now: () => '2026-01-01T00:00:00.000Z',
      events: { append: async () => {}, listByTask: async () => [] },
      gate1: new FakeGate1(),
      sweepDesigner: new FakeSweepDesigner(),
      resultInterpreter: new FakeResultInterpreter(),
      paramGridRunner: new ParamGridRunner({ strategyRunExecutor: executor }),
      strategyBacktests: new InMemoryStrategyBacktestRunRepository(),
    });

    await svc.runStrategyBaselineValidation(baseInput());

    expect(entered).toEqual(expect.arrayContaining(['sanity', 'train', 'holdout']));
    expect(maxInFlight).toBe(2); // train and holdout overlapped
  });

  it('verdict parity: train fails ⇒ INCONCLUSIVE train_not_run even though holdout completed', async () => {
    const resultFor = (role: MemberRole): StrategyExperimentRunResult => {
      if (role === 'sanity') return { status: 'completed', runId: 'r-sanity', platformRunId: 'plat-sanity', totalTrades: 90 };
      if (role === 'train') return { status: 'rejected', runId: 'r-train', platformRunId: 'plat-train' };
      return { status: 'completed', runId: 'r-holdout', platformRunId: 'plat-holdout', totalTrades: 30, metrics: viableHoldoutMetrics() };
    };
    const { svc, experiments } = buildSvc(resultFor, { 'plat-sanity': trades(90) });

    const { experimentId, verdict } = await svc.runStrategyBaselineValidation(baseInput());

    expect(verdict).toBe('INCONCLUSIVE');
    const exp = await experiments.findById(experimentId);
    expect(exp?.verdictReason).toBe('train_not_run');
  });

  it('verdict parity: train pending ⇒ INCONCLUSIVE run_pending (checked before holdout outcome)', async () => {
    const resultFor = (role: MemberRole): StrategyExperimentRunResult => {
      if (role === 'sanity') return { status: 'completed', runId: 'r-sanity', platformRunId: 'plat-sanity', totalTrades: 90 };
      if (role === 'train') return { status: 'pending', runId: 'r-train', platformRunId: 'plat-train' };
      return { status: 'rejected', runId: 'r-holdout', platformRunId: 'plat-holdout' };
    };
    const { svc, experiments } = buildSvc(resultFor, { 'plat-sanity': trades(90) });

    const { experimentId, verdict } = await svc.runStrategyBaselineValidation(baseInput());

    expect(verdict).toBe('INCONCLUSIVE');
    const exp = await experiments.findById(experimentId);
    expect(exp?.verdictReason).toBe('run_pending');
  });

  it('verdict parity: train completed + holdout rejected ⇒ INCONCLUSIVE holdout_not_run', async () => {
    const resultFor = (role: MemberRole): StrategyExperimentRunResult => {
      if (role === 'sanity') return { status: 'completed', runId: 'r-sanity', platformRunId: 'plat-sanity', totalTrades: 90 };
      if (role === 'train') return { status: 'completed', runId: 'r-train', platformRunId: 'plat-train', totalTrades: 60, metrics: viableHoldoutMetrics() };
      return { status: 'rejected', runId: 'r-holdout', platformRunId: 'plat-holdout' };
    };
    const { svc, experiments } = buildSvc(resultFor, { 'plat-sanity': trades(90) });

    const { experimentId, verdict } = await svc.runStrategyBaselineValidation(baseInput());

    expect(verdict).toBe('INCONCLUSIVE');
    const exp = await experiments.findById(experimentId);
    expect(exp?.verdictReason).toBe('holdout_not_run');
  });

  it('verdict parity: train rejected + holdout rejected ⇒ INCONCLUSIVE train_not_run (train-first ordering wins)', async () => {
    const resultFor = (role: MemberRole): StrategyExperimentRunResult => {
      if (role === 'sanity') return { status: 'completed', runId: 'r-sanity', platformRunId: 'plat-sanity', totalTrades: 90 };
      if (role === 'train') return { status: 'rejected', runId: 'r-train', platformRunId: 'plat-train' };
      return { status: 'rejected', runId: 'r-holdout', platformRunId: 'plat-holdout' };
    };
    const { svc, experiments } = buildSvc(resultFor, { 'plat-sanity': trades(90) });

    const { experimentId, verdict } = await svc.runStrategyBaselineValidation(baseInput());

    expect(verdict).toBe('INCONCLUSIVE');
    const exp = await experiments.findById(experimentId);
    expect(exp?.verdictReason).toBe('train_not_run');
  });
});
