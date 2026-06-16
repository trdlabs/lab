// src/adapters/repository/in-memory-backtest-run.repository.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryBacktestRunRepository } from './in-memory-backtest-run.repository.ts';
import type { BacktestRun, BacktestCompletion } from '../../domain/backtest-run.ts';
import type { BacktestMetricBlock } from '../../ports/platform-gateway.port.ts';

function metricBlock(over: Partial<BacktestMetricBlock> = {}): BacktestMetricBlock {
  return { netPnlUsd: 250, netPnlPct: 2.5, totalTrades: 30, winRate: 0.6, profitFactor: 2, maxDrawdownPct: 8, expectancyUsd: 8, sharpe: 1.4, topTradeContributionPct: 22, ...over };
}
function run(id: string, over: Partial<BacktestRun> = {}): BacktestRun {
  const now = '2026-01-01T00:00:00Z';
  return {
    id, hypothesisBuildId: 'b1', hypothesisId: 'h1', strategyProfileId: 'p1',
    platformRunId: 'mock-run-1', correlationId: 'c1', params: {}, paramsHash: 'sha256:p', bundleHash: 'sha256:bh',
    status: 'submitted', baselineModuleId: 'strategy:p1', variantModuleId: 'overlay-h1',
    backend: 'sp4_mock', resumeToken: null, platformRun: null,
    metrics: null, baselineMetrics: null, deltaNetPnlUsd: null, deltaMaxDrawdownPct: null, isFragile: null,
    artifactRefs: [], platformContractVersion: 'mock-0', sdkContractVersion: 'builder-sdk-v0',
    submittedAt: now, finishedAt: null, createdAt: now, updatedAt: now, ...over,
  };
}
function completion(): BacktestCompletion {
  return { metrics: metricBlock(), baselineMetrics: metricBlock({ netPnlUsd: 100, winRate: 0.5, maxDrawdownPct: 7 }), deltaNetPnlUsd: 150, deltaMaxDrawdownPct: 1, isFragile: false, artifactRefs: [], platformContractVersion: 'mock-0', finishedAt: '2026-01-02T00:00:00Z' };
}

describe('InMemoryBacktestRunRepository', () => {
  it('createSubmitted then findById', async () => {
    const repo = new InMemoryBacktestRunRepository();
    await repo.createSubmitted(run('r1'));
    expect((await repo.findById('r1'))?.status).toBe('submitted');
  });

  it('throws on duplicate (hypothesisId, paramsHash, bundleHash)', async () => {
    const repo = new InMemoryBacktestRunRepository();
    await repo.createSubmitted(run('r1'));
    await expect(repo.createSubmitted(run('r2'))).rejects.toThrow(/already exists for/);
  });

  it('allows a new bundle_hash for the same hypothesis + params', async () => {
    const repo = new InMemoryBacktestRunRepository();
    await repo.createSubmitted(run('r1'));
    await repo.createSubmitted(run('r2', { bundleHash: 'sha256:other' }));
    expect(await repo.listByHypothesis('h1')).toHaveLength(2);
  });

  it('markCompleted writes metrics + deltas', async () => {
    const repo = new InMemoryBacktestRunRepository();
    await repo.createSubmitted(run('r1'));
    await repo.markCompleted('r1', completion());
    const row = await repo.findById('r1');
    expect(row?.status).toBe('completed');
    expect(row?.metrics?.netPnlUsd).toBe(250);
    expect(row?.deltaNetPnlUsd).toBe(150);
    expect(row?.isFragile).toBe(false);
  });

  it('markEvaluated / markRejected / markFailed set status', async () => {
    const repo = new InMemoryBacktestRunRepository();
    await repo.createSubmitted(run('r1'));
    await repo.markEvaluated('r1');
    expect((await repo.findById('r1'))?.status).toBe('evaluated');
    await repo.createSubmitted(run('r2', { bundleHash: 'sha256:b2' }));
    await repo.markRejected('r2');
    expect((await repo.findById('r2'))?.status).toBe('rejected');
    await repo.createSubmitted(run('r3', { bundleHash: 'sha256:b3' }));
    await repo.markFailed('r3');
    expect((await repo.findById('r3'))?.status).toBe('failed');
  });

  it('findByIdentity returns the matching run or null', async () => {
    const repo = new InMemoryBacktestRunRepository();
    await repo.createSubmitted(run('r1'));
    expect((await repo.findByIdentity('h1', 'sha256:p', 'sha256:bh'))?.id).toBe('r1');
    expect(await repo.findByIdentity('h1', 'sha256:p', 'sha256:other')).toBeNull();
  });

  it('round-trips backend / resumeToken / platformRun', async () => {
    const repo = new InMemoryBacktestRunRepository();
    const r = { ...run('rp1'), id: 'rp1', backend: 'research_platform' as const, resumeToken: 'tok', platformRun: {
      datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2023-01-01', to: '2023-06-30' }, seed: 7,
    } };
    await repo.createSubmitted(r);
    const got = await repo.findById('rp1');
    expect(got?.backend).toBe('research_platform');
    expect(got?.resumeToken).toBe('tok');
    expect(got?.platformRun?.datasetId).toBe('ds');
  });

  it('round-trips taskId for research_platform runs', async () => {
    const repo = new InMemoryBacktestRunRepository();
    await repo.createSubmitted({ ...run('rt1'), backend: 'research_platform', taskId: 't-123' });
    expect((await repo.findById('rt1'))?.taskId).toBe('t-123');
  });

  it('listResumablePlatformRuns returns only submitted research_platform runs', async () => {
    const repo = new InMemoryBacktestRunRepository();
    await repo.createSubmitted({ ...run('a'), backend: 'research_platform', taskId: 't1' });                       // submitted + research_platform -> yes
    await repo.createSubmitted({ ...run('b', { bundleHash: 'sha256:b2' }), backend: 'sp4_mock' });                  // sp4_mock -> no
    await repo.createSubmitted({ ...run('c', { bundleHash: 'sha256:b3' }), backend: 'research_platform', taskId: 't1' });
    await repo.markEvaluated('c');                                                                                  // evaluated -> no
    const resumable = await repo.listResumablePlatformRuns();
    expect(resumable.map((r) => r.id)).toEqual(['a']);
  });
});
