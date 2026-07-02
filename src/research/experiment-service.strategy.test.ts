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
});
