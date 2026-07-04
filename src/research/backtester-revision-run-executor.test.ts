import { describe, it, expect } from 'vitest';
import { BacktesterRevisionRunExecutor } from './backtester-revision-run-executor.ts';
import { InMemoryStrategyBacktestRunRepository } from '../adapters/repository/in-memory-strategy-backtest-run.repository.ts';
import { computeStrategyParamsHash } from './strategy-run-identity.ts';
import type { StrategyBacktestRun } from '../domain/strategy-backtest-run.ts';

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

const baseReq = {
  revisionId: 'rev_1', label: 'candidate' as const, strategyBundle: bundle,
  strategyProfileId: 'p1', run, metrics: ['netPnlUsd'], correlationId: 'corr_1',
};

describe('BacktesterRevisionRunExecutor', () => {
  it('submits, persists, polls, maps metrics on completed — runKind revision_combo', async () => {
    const repo = new InMemoryStrategyBacktestRunRepository();
    const exec = new BacktesterRevisionRunExecutor({
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
    const out = await exec.execute(baseReq);

    expect(out.status).toBe('completed');
    expect(out.runId).toBeTruthy();
    expect(out.platformRunId).toBe('pr_1');
    expect(out.totalTrades).toBe(3);
    expect(out.metrics?.netPnlUsd).toBe(5);

    const persisted = await repo.findById(out.runId);
    expect(persisted?.status).toBe('completed');
    expect(persisted?.strategyProfileId).toBe('p1');
    expect(persisted?.strategyBundleId).toBe('mod_x');
    expect(persisted?.runKind).toBe('revision_combo');
    expect(persisted?.correlationId).toBe('corr_1');
    expect(persisted?.taskId).toBe('rev_1');
    expect(persisted?.platformRunId).toBe('pr_1');
    expect(persisted?.metrics?.totalTrades).toBe(3);
  });

  it('dedups: an existing COMPLETED row with metrics is returned WITHOUT resubmitting', async () => {
    const repo = new InMemoryStrategyBacktestRunRepository();
    const paramsHash = computeStrategyParamsHash({ bundleHash: bundle.bundleHash, platformRun: run, params: {} });
    const existing: StrategyBacktestRun = {
      id: 'existing_run', strategyProfileId: 'p1', strategyBundleId: 'mod_x',
      bundleHash: bundle.bundleHash, paramsHash, runKind: 'revision_combo',
      platformRunId: 'pr_existing', correlationId: 'corr_prior', taskId: 'rev_0',
      resumeToken: undefined, params: {}, status: 'completed',
      metrics: { netPnlUsd: 9, netPnlPct: 0, totalTrades: 7, winRate: 0.5, profitFactor: 1.1, maxDrawdownPct: 3, expectancyUsd: 0, sharpe: 0.4, topTradeContributionPct: 10 },
      platformRun: run, artifactRefs: [], platformContractVersion: 'platform-v1', sdkContractVersion: 'builder-sdk-v0',
      backend: 'research_platform', submittedAt: 't0', finishedAt: 't0', createdAt: 't0', updatedAt: 't0',
    };
    await repo.createSubmitted(existing);
    await repo.markCompleted('existing_run', {
      metrics: existing.metrics!, artifactRefs: [], platformContractVersion: 'platform-v1', finishedAt: 't0',
    });

    let submitCalls = 0;
    const exec = new BacktesterRevisionRunExecutor({
      platform: {
        submitStrategyResearchRun: async () => { submitCalls += 1; return { runId: 'pr_should_not_happen' }; },
        getRunStatus: async () => ({ status: 'completed' }),
        getRunResult: async () => { throw new Error('should not be called'); },
      } as any,
      strategyBacktests: repo,
      poll: { maxPolls: 1, pollDelayMs: 0, sleep: async () => {} },
      now: () => 't1',
    });
    const out = await exec.execute(baseReq);

    expect(submitCalls).toBe(0);
    expect(out.status).toBe('completed');
    expect(out.runId).toBe('existing_run');
    expect(out.platformRunId).toBe('pr_existing');
    expect(out.totalTrades).toBe(7);
  });

  it('marks rejected on a rejected outcome and propagates', async () => {
    const repo = new InMemoryStrategyBacktestRunRepository();
    const exec = new BacktesterRevisionRunExecutor({
      platform: {
        submitStrategyResearchRun: async () => ({ runId: 'pr_2' }),
        getRunStatus: async () => ({ status: 'failed', terminalCode: 'x' }),
        getRunResult: async () => ({ kind: 'status', view: { status: 'failed', terminalCode: 'x' } }),
      } as any,
      strategyBacktests: repo,
      poll: { maxPolls: 1, pollDelayMs: 0, sleep: async () => {} },
      now: () => 't',
    });
    const out = await exec.execute({ ...baseReq, label: 'comparison_baseline' });

    expect(out.status).toBe('rejected');
    expect(out.platformRunId).toBe('pr_2');
    const persisted = await repo.findById(out.runId);
    expect(persisted?.status).toBe('rejected');
    expect(persisted?.runKind).toBe('revision_combo');
  });

  it('returns pending without marking the run terminal', async () => {
    const repo = new InMemoryStrategyBacktestRunRepository();
    const exec = new BacktesterRevisionRunExecutor({
      platform: {
        submitStrategyResearchRun: async () => ({ runId: 'pr_3' }),
        getRunStatus: async () => ({ status: 'running' }),
        getRunResult: async () => { throw new Error('should not be called while pending'); },
      } as any,
      strategyBacktests: repo,
      poll: { maxPolls: 1, pollDelayMs: 0, sleep: async () => {} },
      now: () => 't',
    });
    const out = await exec.execute(baseReq);

    expect(out.status).toBe('pending');
    const persisted = await repo.findById(out.runId);
    expect(persisted?.status).toBe('submitted');
  });

  it('persists platformRun (the run-context) on the submitted revision_combo row', async () => {
    const created: StrategyBacktestRun[] = [];
    const strategyBacktests = {
      findByBundleAndParams: async () => null,
      createSubmitted: async (r: StrategyBacktestRun) => { created.push(r); },
      markCompleted: async () => {},
      markRejected: async () => {},
      markFailed: async () => {},
    };
    const testRun = { datasetId: 'ds-1', symbols: ['ESPORTSUSDT'], timeframe: '1h', period: { from: '2026-06-12', to: '2026-06-19' }, seed: 42 };
    const executor = new BacktesterRevisionRunExecutor({
      platform: {
        submitStrategyResearchRun: async () => ({ runId: 'pr_new' }),
        getRunStatus: async () => ({ status: 'completed' }),
        getRunResult: async () => ({
          kind: 'summary' as const,
          summary: {
            status: 'completed',
            artifactRefs: [],
            metrics: rawMetrics,
            evidence: { seed: 42, contractVersion: 'platform-v1', moduleVersions: [] },
          },
        }),
      } as any,
      strategyBacktests: strategyBacktests as any,
      poll: { maxPolls: 1, pollDelayMs: 0, sleep: async () => {} },
      now: () => '2026-07-05T00:00:00.000Z',
    });
    await executor.execute({
      revisionId: 'rev-1',
      label: 'candidate',
      strategyBundle: bundle,
      strategyProfileId: 'prof-1',
      run: testRun,
      metrics: ['pnl', 'sharpe', 'max_drawdown', 'win_rate', 'total_trades', 'profit_factor', 'top_trade_contribution_pct'],
      correlationId: 'c1',
    });
    expect(created).toHaveLength(1);
    expect(created[0]!.platformRun).toEqual(testRun);
  });
});
