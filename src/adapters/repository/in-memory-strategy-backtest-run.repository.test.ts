import { describe, it, expect } from 'vitest';
import { InMemoryStrategyBacktestRunRepository } from './in-memory-strategy-backtest-run.repository.ts';
import { STRATEGY_RUN_KIND, type StrategyBacktestRun } from '../../domain/strategy-backtest-run.ts';

const base = (over: Partial<StrategyBacktestRun> = {}): StrategyBacktestRun => ({
  id: 'sbr_1', strategyProfileId: 'p1', strategyBundleId: 'mod_x', bundleHash: 'sha256:h', paramsHash: 'ph',
  runKind: STRATEGY_RUN_KIND, platformRunId: 'run_1', correlationId: 'sanity', params: {}, status: 'submitted',
  metrics: null, platformRun: null, artifactRefs: [], platformContractVersion: 'pending',
  admission: null,
  sdkContractVersion: 'builder-sdk-v0', backend: 'research_platform', submittedAt: 't', finishedAt: null,
  createdAt: 't', updatedAt: 't', ...over,
});

describe('InMemoryStrategyBacktestRunRepository', () => {
  it('round-trips + resolves by identity + platformRunId', async () => {
    const repo = new InMemoryStrategyBacktestRunRepository();
    await repo.createSubmitted(base());
    expect((await repo.findById('sbr_1'))?.bundleHash).toBe('sha256:h');
    expect((await repo.findByPlatformRunId('run_1'))?.id).toBe('sbr_1');
    expect((await repo.findByIdentity('mod_x', 'ph', 'sha256:h'))?.id).toBe('sbr_1');
  });
  it('markCompleted writes metrics + completed status', async () => {
    const repo = new InMemoryStrategyBacktestRunRepository();
    await repo.createSubmitted(base());
    await repo.markCompleted('sbr_1', {
      metrics: { netPnlUsd: 10, netPnlPct: 1, totalTrades: 3, winRate: 0.66, profitFactor: 1.5,
        maxDrawdownPct: 5, expectancyUsd: 3, sharpe: 0.9, topTradeContributionPct: 40 },
      artifactRefs: ['a1'], platformContractVersion: 'v1', finishedAt: 't2',
    });
    const r = await repo.findById('sbr_1');
    expect(r?.status).toBe('completed');
    expect(r?.metrics?.totalTrades).toBe(3);
  });
  it('markRejected / markFailed set status + stamp finishedAt', async () => {
    const repo = new InMemoryStrategyBacktestRunRepository();
    await repo.createSubmitted(base());
    await repo.markRejected('sbr_1');
    const rejected = await repo.findById('sbr_1');
    expect(rejected?.status).toBe('rejected');
    expect(rejected?.finishedAt).toBeTruthy();

    await repo.createSubmitted(base({ id: 'sbr_2', platformRunId: 'run_2' }));
    await repo.markFailed('sbr_2');
    const failed = await repo.findById('sbr_2');
    expect(failed?.status).toBe('failed');
    expect(failed?.finishedAt).toBeTruthy();
  });
});
