import { describe, it, expect } from 'vitest';
import { handleBacktestCompletionCallback } from './handle-backtest-callback.ts';
import { InMemoryResearchTaskRepository } from '../adapters/repository/in-memory-research-task.repository.ts';
import { InMemoryBacktestRunRepository } from '../adapters/repository/in-memory-backtest-run.repository.ts';
import { InMemoryQueueAdapter } from '../adapters/queue/in-memory-queue.adapter.ts';
import type { BacktestRun } from '../domain/backtest-run.ts';
import type { BacktestCompletionCallback } from '../domain/backtest-callback.schema.ts';

const NOW = '2026-01-01T00:00:00Z';

function run(over: Partial<BacktestRun> = {}): BacktestRun {
  return {
    id: 'br1', hypothesisBuildId: 'b1', hypothesisId: 'h1', strategyProfileId: 'p1',
    platformRunId: 'platform-run-1', correlationId: 'c1', params: {}, paramsHash: 'sha256:p', bundleHash: 'sha256:bh',
    status: 'submitted', baselineModuleId: 'strategy:p1', variantModuleId: 'overlay-h1',
    backend: 'research_platform', resumeToken: 'tok', taskId: 't1',
    platformRun: { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2023-01-01', to: '2023-06-30' }, seed: 7 },
    admission: null,
    metrics: null, baselineMetrics: null, deltaNetPnlUsd: null, deltaMaxDrawdownPct: null, isFragile: null,
    artifactRefs: [], platformContractVersion: 'pending', sdkContractVersion: 'builder-sdk-v0',
    submittedAt: NOW, finishedAt: null, createdAt: NOW, updatedAt: NOW, ...over,
  };
}

function event(over: Partial<BacktestCompletionCallback> = {}): BacktestCompletionCallback {
  return {
    eventType: 'job_completed',
    jobId: 'job-1',
    runId: 'platform-run-1',
    status: 'completed',
    correlationId: 'c1',
    summary: {},
    emittedAtMs: Date.now(),
    ...over,
  };
}

describe('handleBacktestCompletionCallback', () => {
  it('ignores unknown platform run id', async () => {
    const repo = new InMemoryResearchTaskRepository();
    const queue = new InMemoryQueueAdapter();
    const backtests = new InMemoryBacktestRunRepository();
    const result = await handleBacktestCompletionCallback(event(), {
      repo,
      queue,
      findRunByPlatformRunId: (id) => backtests.findByPlatformRunId(id),
    });
    expect(result).toEqual({ status: 'accepted', action: 'ignored', reason: 'run_not_found' });
    expect(queue.queued).toHaveLength(0);
  });

  it('ignores runs that are no longer submitted', async () => {
    const repo = new InMemoryResearchTaskRepository();
    const queue = new InMemoryQueueAdapter();
    const backtests = new InMemoryBacktestRunRepository();
    await backtests.createSubmitted(run());
    await backtests.markEvaluated('br1');
    const result = await handleBacktestCompletionCallback(event(), {
      repo,
      queue,
      findRunByPlatformRunId: (id) => backtests.findByPlatformRunId(id),
    });
    expect(result).toEqual({ status: 'accepted', action: 'ignored', reason: 'not_resumable' });
  });

  it('enqueues backtest.resume with dedupe key', async () => {
    const repo = new InMemoryResearchTaskRepository();
    const queue = new InMemoryQueueAdapter();
    const backtests = new InMemoryBacktestRunRepository();
    await backtests.createSubmitted(run());
    const first = await handleBacktestCompletionCallback(event(), {
      repo,
      queue,
      findRunByPlatformRunId: (id) => backtests.findByPlatformRunId(id),
    });
    const second = await handleBacktestCompletionCallback(event(), {
      repo,
      queue,
      findRunByPlatformRunId: (id) => backtests.findByPlatformRunId(id),
    });
    expect(first.action).toBe('enqueued');
    expect(second.action).toBe('deduped');
    expect(queue.queued).toHaveLength(1);
    expect(queue.queued[0]!.taskType).toBe('backtest.resume');
    expect(queue.queued[0]!.dedupeKey).toBe('backtest.resume:platform-run-1');
  });
});
