import { describe, it, expect } from 'vitest';
import { runOverlayBacktest, pollOverlayRun } from './run-backtest.ts';
import type { ResearchPlatformPort, RunStatusView, RunResultView, RunJobHandle, SubmitOverlayRunOptions } from '../ports/research-platform.port.ts';
import type { ModuleBundle } from '../domain/module-bundle.ts';

const bundle = {} as ModuleBundle;
const opts = { target: { kind: 'baseline_ref' as const, moduleRef: { id: 'strategy:p1', version: '1.0.0' } }, run: { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2023-01-01', to: '2023-12-31' }, seed: 7 } } satisfies SubmitOverlayRunOptions;
const noSleep = async () => {};
const handle: RunJobHandle = { jobId: 'j', runId: 'r', status: 'accepted', effectiveSeed: 7, requestFingerprint: 'f', idempotentReplay: false };

function fakePort(statuses: RunStatusView['status'][], result: RunResultView): ResearchPlatformPort {
  let i = 0;
  return {
    discover: async () => ({}) as never, listDatasets: async () => ({ datasets: [] }), validateModule: async () => ({ status: 'accepted', issues: [], executed: false }),
    submitOverlayRun: async () => handle,
    getRunStatus: async () => ({ jobId: 'j', runId: 'r', status: statuses[Math.min(i++, statuses.length - 1)], timeline: { acceptedAtMs: 0 } }),
    getRunResult: async () => result,
  } as unknown as ResearchPlatformPort;
}

const completed: RunResultView = { ok: true, kind: 'summary', summary: { runId: 'r', status: 'completed', runKind: 'baseline-vs-variant', validationIssues: [], metrics: {}, comparison: { baseline: {}, variant: {}, deltas: {} }, coverage: [], artifactRefs: [{ artifactId: 'sha256:a', artifactType: 'metrics', availability: { status: 'available' } }], evidence: { seed: 7, contractVersion: '017.2', moduleVersions: [] } } } as unknown as RunResultView;

describe('runOverlayBacktest', () => {
  it('completed: polls to terminal then returns a completed outcome with artifact IDs', async () => {
    const out = await runOverlayBacktest(fakePort(['queued', 'running', 'completed'], completed), bundle, opts, { maxPolls: 5, pollDelayMs: 0, sleep: noSleep });
    expect(out.status).toBe('completed');
    if (out.status === 'completed') { expect(out.runId).toBe('r'); expect(out.artifactIds).toEqual(['sha256:a']); expect(out.summary.status).toBe('completed'); }
  });
  it('pending: poll budget exhausted without a terminal status', async () => {
    const out = await runOverlayBacktest(fakePort(['running'], completed), bundle, opts, { maxPolls: 3, pollDelayMs: 0, sleep: noSleep });
    expect(out.status).toBe('pending');
  });
  it('rejected: terminal non-completed status', async () => {
    const failed: RunResultView = { ok: true, kind: 'status', view: { jobId: 'j', runId: 'r', status: 'failed', timeline: { acceptedAtMs: 0 }, terminalCode: 'runner_failure' } } as unknown as RunResultView;
    const out = await runOverlayBacktest(fakePort(['failed'], failed), bundle, opts, { maxPolls: 3, pollDelayMs: 0, sleep: noSleep });
    expect(out.status).toBe('rejected');
  });
});

describe('pollOverlayRun', () => {
  it('returns completed with mapped artifactIds when status is terminal and result is a completed summary', async () => {
    const port = {
      getRunStatus: async () => ({ jobId: 'j', runId: 'r1', status: 'completed', timeline: { acceptedAtMs: 0, terminalAtMs: 1 } }),
      getRunResult: async () => ({ ok: true, kind: 'summary', summary: {
        runId: 'r1', status: 'completed', runKind: 'baseline-vs-variant', validationIssues: [],
        metrics: {}, comparison: { baseline: {}, variant: {}, deltas: {} },
        coverage: [], artifactRefs: [{ artifactId: 'a1', artifactType: 'metrics', availability: { status: 'available' } }],
        evidence: { seed: 0, contractVersion: '017.2', moduleVersions: [] },
      } }),
    } as unknown as Parameters<typeof pollOverlayRun>[0];
    const outcome = await pollOverlayRun(port, 'r1', { maxPolls: 3, pollDelayMs: 0 });
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') expect(outcome.artifactIds).toEqual(['a1']);
  });

  it('returns pending when no terminal status is reached within maxPolls', async () => {
    let calls = 0;
    const port = {
      getRunStatus: async () => { calls += 1; return { jobId: 'j', runId: 'r1', status: 'running', timeline: { acceptedAtMs: 0 } }; },
      getRunResult: async () => { throw new Error('should not be called'); },
    } as unknown as Parameters<typeof pollOverlayRun>[0];
    const outcome = await pollOverlayRun(port, 'r1', { maxPolls: 3, pollDelayMs: 0 });
    expect(outcome.status).toBe('pending');
    expect(calls).toBe(3);
  });
});
