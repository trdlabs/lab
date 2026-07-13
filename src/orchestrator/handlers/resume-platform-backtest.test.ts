import { describe, it, expect } from 'vitest';
import { resumePlatformRun, resumePendingPlatformRuns } from './resume-platform-backtest.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import { MockResearchPlatformAdapter } from '../../adapters/platform/mock-research-platform.adapter.ts';
import type { AppServices } from '../app-services.ts';
import type { BacktestRun } from '../../domain/backtest-run.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { ResearchPlatformPort } from '../../ports/research-platform.port.ts';
import { InMemoryQueueAdapter } from '../../adapters/queue/in-memory-queue.adapter.ts';

const PLATFORM_RUN = { datasetId: 'ds', symbols: ['ETHUSDT'], timeframe: '1h', period: { from: '2023-01-01', to: '2023-06-30' }, seed: 7 };
const NOW = '2026-01-01T00:00:00Z';

function run(id: string, over: Partial<BacktestRun> = {}): BacktestRun {
  return {
    id, hypothesisBuildId: 'b1', hypothesisId: 'h1', strategyProfileId: 'p1',
    platformRunId: 'r-1', correlationId: 'c1', params: {}, paramsHash: 'sha256:p', bundleHash: 'sha256:bh',
    status: 'submitted', baselineModuleId: 'strategy:p1', variantModuleId: 'overlay-h1',
    backend: 'sp4_mock', resumeToken: null, platformRun: null,
    metrics: null, baselineMetrics: null, deltaNetPnlUsd: null, deltaMaxDrawdownPct: null, isFragile: null,
    artifactRefs: [], platformContractVersion: 'mock-0', sdkContractVersion: 'builder-sdk-v0',
    submittedAt: NOW, finishedAt: null, createdAt: NOW, updatedAt: NOW, ...over,
  };
}
function task(): ResearchTask {
  return { id: 't1', taskType: 'hypothesis.build', source: 'operator', correlationId: 'c1', status: 'running', payload: {}, createdAt: NOW, updatedAt: NOW };
}
function platformRun(id: string, over: Partial<BacktestRun> = {}): BacktestRun {
  return run(id, { backend: 'research_platform', taskId: 't1', platformRunId: 'r-1', resumeToken: 'tok', platformRun: PLATFORM_RUN, ...over });
}
/** A complete 7-metric completed summary (mirrors the mock); profit_factor present on both sides -> no MetricMappingError. */
function cannedFor(runId: string): never {
  const m = { pnl: 1500, sharpe: 1.6, max_drawdown: 0.14, win_rate: 0.58, total_trades: 42, profit_factor: 2.1, top_trade_contribution_pct: 28 };
  const baseline = { ...m, pnl: 800, profit_factor: 1.5 };
  return { runId, status: 'completed', runKind: 'baseline-vs-variant', validationIssues: [],
    metrics: baseline, comparison: { baseline, variant: m, deltas: {} },
    coverage: [], artifactRefs: [], evidence: { seed: 0, contractVersion: '017.2', moduleVersions: [] } } as never;
}
async function seed(s: AppServices, over: Partial<BacktestRun> = {}): Promise<BacktestRun> {
  await s.researchTasks.create(task());
  const r = platformRun('rp1', over);
  await s.backtests.createSubmitted(r);
  return r;
}

describe('resumePlatformRun', () => {
  it('KEY CHECK: completed resume → exactly one Evaluation, run evaluated, bracket events', async () => {
    const s = makeServices(); // default MockResearchPlatformAdapter reports completed
    const r = await seed(s);
    const outcome = await resumePlatformRun(s, r);
    expect(outcome).toEqual({ kind: 'completed', runId: 'rp1' });
    expect((await s.backtests.findById('rp1'))?.status).toBe('evaluated');
    expect(await s.evaluations.listByBacktestRun('rp1')).toHaveLength(1);
    const types = (await s.events.listByTask('t1')).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['backtest.resume.started', 'backtest.completed', 'evaluation.completed', 'backtest.resume.completed']));
  });

  it('enqueued backtest.completed payload carries the originating (non-default) symbol from the persisted platformRun', async () => {
    const queue = new InMemoryQueueAdapter();
    const s = makeServices({ taskQueue: queue }); // default MockResearchPlatformAdapter reports completed
    const r = await seed(s);
    await resumePlatformRun(s, r);

    const enqueued = queue.queued.filter((q) => q.taskType === 'backtest.completed');
    expect(enqueued).toHaveLength(1);
    const completedTask = await s.researchTasks.findById(enqueued[0]!.taskId);
    expect(completedTask!.payload).toMatchObject({ symbol: 'ETHUSDT' });
  });

  it('enqueued backtest.completed payload carries evalPlatformRun from the fresh re-read, not the stale input (resume)', async () => {
    const queue = new InMemoryQueueAdapter();
    const s = makeServices({ researchPlatform: new MockResearchPlatformAdapter(), taskQueue: queue });
    // Persist the canonical run with the REAL window.
    const persistedWindow = { datasetId: 'ds', symbols: ['ETHUSDT'], timeframe: '1h', period: { from: '2026-01-01', to: '2026-03-01' }, seed: 7 };
    const r = await seed(s, { platformRun: persistedWindow });
    // Caller passes a STALE copy with a different window; the producer must ignore it.
    const staleInput = { ...r, platformRun: { ...persistedWindow, period: { from: '1999-01-01', to: '1999-02-01' } } };
    await resumePlatformRun(s, staleInput);

    const enqueued = queue.queued.filter((q) => q.taskType === 'backtest.completed');
    expect(enqueued).toHaveLength(1);
    const completedTask = await s.researchTasks.findById(enqueued[0]!.taskId);
    expect(completedTask!.payload.evalPlatformRun).toEqual(persistedWindow); // fresh read wins over stale input
  });

  it('second resume after finalize → already_evaluated, no duplicate Evaluation', async () => {
    const s = makeServices();
    const r = await seed(s);
    await resumePlatformRun(s, r);
    const second = await resumePlatformRun(s, r); // r is stale (still 'submitted' in the object)
    expect(second).toEqual({ kind: 'skipped', runId: 'rp1', reason: 'already_evaluated' });
    expect(await s.evaluations.listByBacktestRun('rp1')).toHaveLength(1);
  });

  it('still pending → run stays submitted, resume.pending, no Evaluation', async () => {
    const stub = { ...new MockResearchPlatformAdapter(),
      getRunStatus: async () => ({ jobId: 'j', runId: 'r-1', status: 'running', timeline: { acceptedAtMs: 0 } }),
      getRunResult: async () => { throw new Error('should not be called'); },
    } as unknown as ResearchPlatformPort;
    const s = makeServices({ researchPlatform: stub, platformPoll: { maxPolls: 3, pollDelayMs: 0 } });
    const r = await seed(s);
    const outcome = await resumePlatformRun(s, r);
    expect(outcome).toEqual({ kind: 'pending', runId: 'rp1' });
    expect((await s.backtests.findById('rp1'))?.status).toBe('submitted');
    expect(await s.evaluations.listByBacktestRun('rp1')).toHaveLength(0);
    const types = (await s.events.listByTask('t1')).map((e) => e.type);
    expect(types).toContain('backtest.resume.pending');
    expect(types).not.toContain('backtest.resume.completed');
  });

  it('rejected → markRejected + backtest.failed(platform_rejected), no resume.completed', async () => {
    const stub = { ...new MockResearchPlatformAdapter(),
      getRunStatus: async () => ({ jobId: 'j', runId: 'r-1', status: 'failed', terminalCode: 'execution_error', timeline: { acceptedAtMs: 0, terminalAtMs: 1 } }),
      getRunResult: async () => ({ ok: true, kind: 'status', view: { jobId: 'j', runId: 'r-1', status: 'failed', terminalCode: 'execution_error', timeline: { acceptedAtMs: 0, terminalAtMs: 1 } } }),
    } as unknown as ResearchPlatformPort;
    const s = makeServices({ researchPlatform: stub });
    const r = await seed(s);
    const outcome = await resumePlatformRun(s, r);
    expect(outcome).toEqual({ kind: 'failed', runId: 'rp1', reason: 'platform_rejected' });
    expect((await s.backtests.findById('rp1'))?.status).toBe('rejected');
    const failed = (await s.events.listByTask('t1')).find((e) => e.type === 'backtest.failed');
    expect(failed?.payload.reason).toBe('platform_rejected');
    expect(failed?.payload.terminalCode).toBe('execution_error');
    expect((await s.events.listByTask('t1')).map((e) => e.type)).not.toContain('backtest.resume.completed');
  });

  it('MetricMappingError (ambiguous profit_factor) → markFailed + result_invalid', async () => {
    const ambiguous = {
      runId: 'r-1', status: 'completed', runKind: 'baseline-vs-variant', validationIssues: [],
      metrics: { pnl: 800, sharpe: 1, max_drawdown: 0.1, win_rate: 0.5, total_trades: 30, top_trade_contribution_pct: 20 },
      comparison: {
        baseline: { pnl: 800, sharpe: 1, max_drawdown: 0.1, win_rate: 0.5, total_trades: 30, top_trade_contribution_pct: 20 },
        variant: { pnl: 1500, sharpe: 1.6, max_drawdown: 0.14, win_rate: 0.58, total_trades: 42, top_trade_contribution_pct: 28 },
        deltas: {},
      },
      coverage: [], artifactRefs: [], evidence: { seed: 0, contractVersion: '017.2', moduleVersions: [] },
    };
    const stub = { ...new MockResearchPlatformAdapter(),
      getRunStatus: async () => ({ jobId: 'j', runId: 'r-1', status: 'completed', timeline: { acceptedAtMs: 0, terminalAtMs: 1 } }),
      getRunResult: async () => ({ ok: true, kind: 'summary', summary: ambiguous as never }),
    } as unknown as ResearchPlatformPort;
    const s = makeServices({ researchPlatform: stub });
    const r = await seed(s);
    const outcome = await resumePlatformRun(s, r);
    expect(outcome).toEqual({ kind: 'failed', runId: 'rp1', reason: 'result_invalid' });
    expect((await s.backtests.findById('rp1'))?.status).toBe('failed');
    const failed = (await s.events.listByTask('t1')).find((e) => e.type === 'backtest.failed');
    expect(failed?.payload.detail).toBe('metric_mapping_error');
  });

  it('missing taskId (legacy pre-0008 row) → skipped, no events', async () => {
    const s = makeServices();
    const r = run('rp1', { backend: 'research_platform', platformRunId: 'r-1', resumeToken: 'tok', platformRun: PLATFORM_RUN });
    await s.backtests.createSubmitted(r);
    const outcome = await resumePlatformRun(s, r);
    expect(outcome).toEqual({ kind: 'skipped', runId: 'rp1', reason: 'missing_task_id' });
    expect(await s.events.listByTask('t1')).toHaveLength(0);
  });

  it('task not found → skipped, no events', async () => {
    const s = makeServices();
    const r = run('rp1', { backend: 'research_platform', taskId: 't-missing', platformRunId: 'r-1', resumeToken: 'tok', platformRun: PLATFORM_RUN });
    await s.backtests.createSubmitted(r);
    const outcome = await resumePlatformRun(s, r);
    expect(outcome).toEqual({ kind: 'skipped', runId: 'rp1', reason: 'task_not_found' });
    expect(await s.events.listByTask('t-missing')).toHaveLength(0);
  });
});

describe('resumePendingPlatformRuns', () => {
  it('enumerates only submitted research_platform runs and isolates per-run errors', async () => {
    const stub = { ...new MockResearchPlatformAdapter(),
      getRunStatus: async (runId: string) => {
        if (runId === 'r-bad') throw new Error('gateway transport down');
        return { jobId: 'j', runId, status: 'completed', timeline: { acceptedAtMs: 0, terminalAtMs: 1 } };
      },
      getRunResult: async (runId: string) => ({ ok: true, kind: 'summary', summary: cannedFor(runId) }),
    } as unknown as ResearchPlatformPort;
    const s = makeServices({ researchPlatform: stub });
    await s.researchTasks.create(task());
    await s.backtests.createSubmitted(platformRun('good', { platformRunId: 'r-good' }));
    await s.backtests.createSubmitted(platformRun('bad', { platformRunId: 'r-bad', bundleHash: 'sha256:b2' }));
    await s.backtests.createSubmitted(run('mock', { bundleHash: 'sha256:b3' })); // sp4_mock submitted -> ignored

    const result = await resumePendingPlatformRuns(s);
    expect(result.total).toBe(2);
    expect(result.outcomes).toContainEqual({ kind: 'completed', runId: 'good' });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.runId).toBe('bad');
    expect(result.counts).toMatchObject({ completed: 1, error: 1 });
    expect((await s.backtests.findById('mock'))?.status).toBe('submitted'); // untouched
  });
});
