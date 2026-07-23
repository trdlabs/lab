import { describe, it, expect } from 'vitest';
import { BacktesterStrategyExperimentRunExecutor } from './backtester-strategy-experiment-run-executor.ts';
import { InMemoryStrategyBacktestRunRepository } from '../adapters/repository/in-memory-strategy-backtest-run.repository.ts';

const bundle = {
  bytes: new Uint8Array(),
  source: '',
  manifest: { id: 'mod_x', version: '1', kind: 'strategy' },
  bundleHash: 'sha256:h',
} as any;
const run = { datasetId: 'd', symbols: ['S'], timeframe: '1h', period: { from: 'a', to: 'b' }, seed: 42 };

// Real snake_case platform metric-catalog keys (RESEARCH_RUN_METRICS in platform-comparison.ts) —
// mapStrategyMetrics reads pnl/total_trades/win_rate/profit_factor/max_drawdown/sharpe/top_trade_contribution_pct.
const rawMetrics = {
  pnl: 5,
  total_trades: 3,
  win_rate: 0.6,
  profit_factor: 1.4,
  max_drawdown: 0.04,
  sharpe: 0.8,
  top_trade_contribution_pct: 30,
};

const fakePlatform = (summary: any) => ({
  submitStrategyResearchRun: async () => ({ runId: 'pr_1' }),
  getRunStatus: async () => ({ status: 'completed' }),
  getRunResult: async () => ({ kind: 'summary', summary }),
} as any);

describe('BacktesterStrategyExperimentRunExecutor', () => {
  it('submits, persists, polls, maps metrics on completed', async () => {
    const repo = new InMemoryStrategyBacktestRunRepository();
    const exec = new BacktesterStrategyExperimentRunExecutor({
      platform: fakePlatform({
        status: 'completed',
        artifactRefs: [],
        metrics: rawMetrics,
        evidence: { seed: 42, contractVersion: 'platform-v1', moduleVersions: [] },
      }),
      strategyBacktests: repo,
      poll: { maxPolls: 1, pollDelayMs: 0, sleep: async () => {} },
      now: () => 't',
    });
    const out = await exec.execute({
      experimentId: 'e1', role: 'sanity', strategyBundle: bundle,
      strategyProfileId: 'p1', run, params: {}, metrics: ['netPnlUsd'],
    });

    expect(out.status).toBe('completed');
    expect(out.runId).toBeTruthy();
    expect(out.platformRunId).toBe('pr_1');
    expect(out.totalTrades).toBe(3);
    expect(out.metrics?.netPnlUsd).toBe(5);
    expect(out.metrics?.profitFactor).toBe(1.4);
    expect(out.metrics?.maxDrawdownPct).toBe(4);
    expect(out.metrics?.sharpe).toBe(0.8);

    const persisted = await repo.findById(out.runId);
    expect(persisted?.status).toBe('completed');
    expect(persisted?.strategyProfileId).toBe('p1');
    expect(persisted?.strategyBundleId).toBe('mod_x');
    expect(persisted?.runKind).toBe('strategy_baseline');
    expect(persisted?.platformRunId).toBe('pr_1');
    expect(persisted?.metrics?.totalTrades).toBe(3);
    expect(persisted?.platformContractVersion).toBe('platform-v1');
  });

  // research-validation-hardening R1 (lab side): the backtester's E2 advisory trial-ledger
  // (DSR + trial count) must reach StrategyExperimentRunResult unmodified when present.
  it('propagates trialContext from outcome.summary when present (E2 passthrough)', async () => {
    const repo = new InMemoryStrategyBacktestRunRepository();
    const trialContext = {
      familyKey: 'fam-1', familyHint: 'ema-cross', trialCount: 4,
      deflatedSharpe: 0.3, sr0: 0.05, vSR: 0.02, vSRBasis: 'empirical' as const, tCount: 4,
    };
    const exec = new BacktesterStrategyExperimentRunExecutor({
      platform: fakePlatform({
        status: 'completed',
        artifactRefs: [],
        metrics: rawMetrics,
        evidence: { seed: 42, contractVersion: 'platform-v1', moduleVersions: [] },
        trialContext,
      }),
      strategyBacktests: repo,
      poll: { maxPolls: 1, pollDelayMs: 0, sleep: async () => {} },
      now: () => 't',
    });
    const out = await exec.execute({
      experimentId: 'e1', role: 'sanity', strategyBundle: bundle,
      strategyProfileId: 'p1', run, params: {}, metrics: ['netPnlUsd'],
    });

    expect(out.trialContext).toEqual(trialContext);
  });

  it('leaves trialContext undefined when outcome.summary carries none (backward compat)', async () => {
    const repo = new InMemoryStrategyBacktestRunRepository();
    const exec = new BacktesterStrategyExperimentRunExecutor({
      platform: fakePlatform({
        status: 'completed',
        artifactRefs: [],
        metrics: rawMetrics,
        evidence: { seed: 42, contractVersion: 'platform-v1', moduleVersions: [] },
      }),
      strategyBacktests: repo,
      poll: { maxPolls: 1, pollDelayMs: 0, sleep: async () => {} },
      now: () => 't',
    });
    const out = await exec.execute({
      experimentId: 'e1', role: 'sanity', strategyBundle: bundle,
      strategyProfileId: 'p1', run, params: {}, metrics: ['netPnlUsd'],
    });

    expect(out.trialContext).toBeUndefined();
  });

  it('marks rejected on a rejected outcome', async () => {
    const repo = new InMemoryStrategyBacktestRunRepository();
    const exec = new BacktesterStrategyExperimentRunExecutor({
      platform: {
        submitStrategyResearchRun: async () => ({ runId: 'pr_2' }),
        getRunStatus: async () => ({ status: 'failed', terminalCode: 'x' }),
        getRunResult: async () => ({ kind: 'status', view: { status: 'failed', terminalCode: 'x' } }),
      } as any,
      strategyBacktests: repo,
      poll: { maxPolls: 1, pollDelayMs: 0, sleep: async () => {} },
      now: () => 't',
    });
    const out = await exec.execute({
      experimentId: 'e1', role: 'sanity', strategyBundle: bundle,
      strategyProfileId: 'p1', run, params: {}, metrics: ['netPnlUsd'],
    });

    expect(out.status).toBe('rejected');
    expect(out.platformRunId).toBe('pr_2');
    const persisted = await repo.findById(out.runId);
    expect(persisted?.status).toBe('rejected');
  });

  it('returns pending without marking the run terminal', async () => {
    const repo = new InMemoryStrategyBacktestRunRepository();
    const exec = new BacktesterStrategyExperimentRunExecutor({
      platform: {
        submitStrategyResearchRun: async () => ({ runId: 'pr_3' }),
        getRunStatus: async () => ({ status: 'running' }),
        getRunResult: async () => { throw new Error('should not be called while pending'); },
      } as any,
      strategyBacktests: repo,
      poll: { maxPolls: 1, pollDelayMs: 0, sleep: async () => {} },
      now: () => 't',
    });
    const out = await exec.execute({
      experimentId: 'e1', role: 'sanity', strategyBundle: bundle,
      strategyProfileId: 'p1', run, params: {}, metrics: ['netPnlUsd'],
    });

    expect(out.status).toBe('pending');
    const persisted = await repo.findById(out.runId);
    expect(persisted?.status).toBe('submitted');
  });

  it('marks failed and returns rejected when mapStrategyMetrics throws', async () => {
    const repo = new InMemoryStrategyBacktestRunRepository();
    const exec = new BacktesterStrategyExperimentRunExecutor({
      platform: fakePlatform({ status: 'completed', artifactRefs: [], metrics: undefined }),
      strategyBacktests: repo,
      poll: { maxPolls: 1, pollDelayMs: 0, sleep: async () => {} },
      now: () => 't',
    });
    const out = await exec.execute({
      experimentId: 'e1', role: 'sanity', strategyBundle: bundle,
      strategyProfileId: 'p1', run, params: {}, metrics: ['netPnlUsd'],
    });

    expect(out.status).toBe('rejected');
    const persisted = await repo.findById(out.runId);
    expect(persisted?.status).toBe('failed');
  });
});
