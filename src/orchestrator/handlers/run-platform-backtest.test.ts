import { describe, it, expect } from 'vitest';
import { runPlatformBacktest } from './run-platform-backtest.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import { MockResearchPlatformAdapter } from '../../adapters/platform/mock-research-platform.adapter.ts';
import { assembleBundle } from '../../domain/module-bundle.ts';
import type { AppServices } from '../app-services.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { ModuleBundle } from '../../domain/module-bundle.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { ResearchPlatformPort } from '../../ports/research-platform.port.ts';
import { InMemoryQueueAdapter } from '../../adapters/queue/in-memory-queue.adapter.ts';

const PLATFORM_RUN = { datasetId: 'ds', symbols: ['ETHUSDT'], timeframe: '1h', period: { from: '2023-01-01', to: '2023-06-30' }, seed: 7 };

function profile(): StrategyProfile {
  const now = '2026-01-01T00:00:00Z';
  return { id: 'p1', version: 1, sourceKind: 'manual_description', sourceFingerprint: 'sha256:s', direction: 'long',
    coreIdea: 'x', requiredMarketFeatures: ['oi'], confidence: 0.6, unknowns: [], profile: {} as never,
    sourceArtifactRef: {} as never, contractVersion: 'strategy-profile-v1', createdAt: now, updatedAt: now };
}
function task(): ResearchTask {
  const now = '2026-01-01T00:00:00Z';
  return { id: 't1', taskType: 'hypothesis.build', source: 'operator', correlationId: 'c1', status: 'running', payload: {}, createdAt: now, updatedAt: now };
}
function bundle(): ModuleBundle {
  return assembleBundle(
    { moduleId: 'm', moduleKind: 'hypothesis_overlay', appliesTo: 'long', entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: 'builder-sdk-v0' },
    { 'index.ts': 'export const overlay = {};' },
    undefined,
  );
}
async function setup(over: Partial<AppServices> = {}) {
  const s = makeServices(over);
  const b = bundle();
  const buildId = 'b1';
  await s.builds.createGenerating({ id: buildId, hypothesisId: 'h1', strategyProfileId: 'p1', status: 'generating',
    builderAdapter: 'fake', builderModel: 'fake', bundleHash: null, bundleArtifactRef: null, manifest: null,
    sdkContractVersion: 'sdk', bundleContractVersion: 'bundle', issues: [], attempt: 1, createdAt: 'now', updatedAt: 'now' });
  const baselineRef = { id: 'strategy:p1', version: 'v1' };
  const common = { services: s, task: task(), buildId, bundle: b, profile: profile(), hypothesisId: 'h1',
    params: {}, platformRun: PLATFORM_RUN, paramsHash: 'ph-test', baselineRef, resumeToken: 'rt-test', cycleDepth: 0 };
  return { s, buildId, common };
}

describe('runPlatformBacktest', () => {
  it('KEY CHECK: completed → mapped comparison → evaluation persisted', async () => {
    const { s, common } = await setup({ researchPlatform: new MockResearchPlatformAdapter(), backtestBackend: 'research_platform' });
    await runPlatformBacktest(common);

    const runs = await s.backtests.listByHypothesis('h1');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('evaluated');
    expect(runs[0]?.backend).toBe('research_platform');
    expect(runs[0]?.platformRun?.datasetId).toBe('ds');
    expect(runs[0]?.resumeToken).toBe('rt-test');
    expect(runs[0]?.taskId).toBe('t1');
    expect(runs[0]?.metrics?.netPnlUsd).toBe(1500);
    expect(runs[0]?.baselineMetrics?.netPnlUsd).toBe(800);
    const evals = await s.evaluations.listByBacktestRun(runs[0]!.id);
    expect(evals).toHaveLength(1);
    const evTypes = (await s.events.listByTask('t1')).map((e) => e.type);
    expect(evTypes).toEqual(expect.arrayContaining(['build.platform_validated', 'backtest.submitted', 'backtest.completed', 'evaluation.completed']));
  });

  it('enqueued backtest.completed payload carries the originating (non-default) symbol', async () => {
    const queue = new InMemoryQueueAdapter();
    const { s, common } = await setup({ researchPlatform: new MockResearchPlatformAdapter(), backtestBackend: 'research_platform', taskQueue: queue });
    await runPlatformBacktest(common);

    const enqueued = queue.queued.filter((q) => q.taskType === 'backtest.completed');
    expect(enqueued).toHaveLength(1);
    const completedTask = await s.researchTasks.findById(enqueued[0]!.taskId);
    expect(completedTask!.payload).toMatchObject({ symbol: 'ETHUSDT' });
  });

  it('pending: poll never terminal → run stays submitted, backtest.pending, no evaluation', async () => {
    const stub = {
      ...new MockResearchPlatformAdapter(),
      validateModule: async () => ({ status: 'accepted', issues: [], executed: false }),
      submitOverlayRun: async () => ({ jobId: 'j', runId: 'r-pending', status: 'accepted', effectiveSeed: 7, requestFingerprint: 'f', idempotentReplay: false }),
      getRunStatus: async () => ({ jobId: 'j', runId: 'r-pending', status: 'running', timeline: { acceptedAtMs: 0 } }),
      getRunResult: async () => { throw new Error('should not be called'); },
    } as unknown as ResearchPlatformPort;
    const { s, common } = await setup({ researchPlatform: stub, platformPoll: { maxPolls: 3, pollDelayMs: 0 } });
    await runPlatformBacktest(common);

    const runs = await s.backtests.listByHypothesis('h1');
    expect(runs[0]?.status).toBe('submitted');
    expect(await s.evaluations.listByBacktestRun(runs[0]!.id)).toHaveLength(0);
    const evTypes = (await s.events.listByTask('t1')).map((e) => e.type);
    expect(evTypes).toContain('backtest.pending');
    expect(evTypes).not.toContain('evaluation.completed');
  });

  it('rejected: terminal non-completed → markRejected + backtest.failed (platform_rejected)', async () => {
    const stub = {
      ...new MockResearchPlatformAdapter(),
      validateModule: async () => ({ status: 'accepted', issues: [], executed: false }),
      submitOverlayRun: async () => ({ jobId: 'j', runId: 'r-rej', status: 'accepted', effectiveSeed: 7, requestFingerprint: 'f', idempotentReplay: false }),
      getRunStatus: async () => ({ jobId: 'j', runId: 'r-rej', status: 'failed', terminalCode: 'execution_error', timeline: { acceptedAtMs: 0, terminalAtMs: 1 } }),
      getRunResult: async () => ({ ok: true, kind: 'status', view: { jobId: 'j', runId: 'r-rej', status: 'failed', terminalCode: 'execution_error', timeline: { acceptedAtMs: 0, terminalAtMs: 1 } } }),
    } as unknown as ResearchPlatformPort;
    const { s, common } = await setup({ researchPlatform: stub });
    await runPlatformBacktest(common);

    const runs = await s.backtests.listByHypothesis('h1');
    expect(runs[0]?.status).toBe('rejected');
    const failed = (await s.events.listByTask('t1')).find((e) => e.type === 'backtest.failed');
    expect(failed?.payload.reason).toBe('platform_rejected');
    expect(failed?.payload.terminalCode).toBe('execution_error');
  });

  it('validate rejected → build_failed, no submit', async () => {
    let submitted = false;
    const stub = {
      ...new MockResearchPlatformAdapter(),
      validateModule: async () => ({ status: 'rejected', issues: [{ severity: 'error', code: 'unsupported_capability', message: 'no', path: 'capabilities' }], executed: false }),
      submitOverlayRun: async () => { submitted = true; throw new Error('must not submit'); },
    } as unknown as ResearchPlatformPort;
    const { s, common } = await setup({ researchPlatform: stub });
    await runPlatformBacktest(common);

    expect(submitted).toBe(false);
    expect(await s.backtests.listByHypothesis('h1')).toHaveLength(0);
    const builds = await s.builds.listByHypothesis('h1');
    expect(builds[0]?.status).toBe('build_failed');
    expect(builds[0]?.issues.map((i) => i.code)).toContain('unsupported_capability');
    const evTypes = (await s.events.listByTask('t1')).map((e) => e.type);
    expect(evTypes).toContain('build_failed');
    expect(evTypes).not.toContain('backtest.submitted');
  });

  it('MetricMappingError (ambiguous profit_factor) → markFailed + result_invalid, no throw', async () => {
    const ambiguous = {
      runId: 'r-amb', status: 'completed', runKind: 'baseline-vs-variant', validationIssues: [],
      metrics: { pnl: 800, sharpe: 1, max_drawdown: 0.1, win_rate: 0.5, total_trades: 30, top_trade_contribution_pct: 20 },
      comparison: {
        baseline: { pnl: 800, sharpe: 1, max_drawdown: 0.1, win_rate: 0.5, total_trades: 30, top_trade_contribution_pct: 20 },
        variant: { pnl: 1500, sharpe: 1.6, max_drawdown: 0.14, win_rate: 0.58, total_trades: 42, top_trade_contribution_pct: 28 },
        deltas: {},
      },
      coverage: [], artifactRefs: [], evidence: { seed: 0, contractVersion: '017.2', moduleVersions: [] },
    };
    const stub = {
      ...new MockResearchPlatformAdapter(),
      validateModule: async () => ({ status: 'accepted', issues: [], executed: false }),
      submitOverlayRun: async () => ({ jobId: 'j', runId: 'r-amb', status: 'accepted', effectiveSeed: 7, requestFingerprint: 'f', idempotentReplay: false }),
      getRunStatus: async () => ({ jobId: 'j', runId: 'r-amb', status: 'completed', timeline: { acceptedAtMs: 0, terminalAtMs: 1 } }),
      getRunResult: async () => ({ ok: true, kind: 'summary', summary: ambiguous as never }),
    } as unknown as ResearchPlatformPort;
    const { s, common } = await setup({ researchPlatform: stub });
    await expect(runPlatformBacktest(common)).resolves.toBeUndefined();

    const runs = await s.backtests.listByHypothesis('h1');
    expect(runs[0]?.status).toBe('failed');
    const failed = (await s.events.listByTask('t1')).find((e) => e.type === 'backtest.failed');
    expect(failed?.payload.reason).toBe('result_invalid');
    expect(failed?.payload.detail).toBe('metric_mapping_error');
  });

  it('infra error: submit throws → propagates (no row persisted)', async () => {
    const stub = {
      ...new MockResearchPlatformAdapter(),
      validateModule: async () => ({ status: 'accepted', issues: [], executed: false }),
      submitOverlayRun: async () => { throw new Error('gateway transport down'); },
    } as unknown as ResearchPlatformPort;
    const { s, common } = await setup({ researchPlatform: stub });
    await expect(runPlatformBacktest(common)).rejects.toThrow(/transport down/);
    expect(await s.backtests.listByHypothesis('h1')).toHaveLength(0);
  });
});
