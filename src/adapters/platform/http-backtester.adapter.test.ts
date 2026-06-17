import { describe, it, expect } from 'vitest';
import {
  BacktesterConflictError,
  BacktesterError,
  type CapabilityDescriptor as BtCapabilityDescriptor,
  type DatasetDescriptor as BtDatasetDescriptor,
  type RunResultSummary as BtRunResultSummary,
  type RunStatusView as BtRunStatusView,
  type RunSubmitRequest as BtRunSubmitRequest,
  type ValidationReport as BtValidationReport,
} from '@trading-backtester/client';
import type { RunJobHandle, SubmitOverlayRunOptions } from '../../ports/research-platform.port.ts';
import type { ModuleBundle } from '../../domain/module-bundle.ts';
import { GatewayRunError } from './gateway-errors.ts';
import { HttpBacktesterAdapter, type BacktesterClientLike } from './http-backtester.adapter.ts';

class FakeClient implements BacktesterClientLike {
  submitted?: BtRunSubmitRequest;
  resultMode: 'summary' | 'conflict' | 'error' = 'summary';

  async submitRun(req: BtRunSubmitRequest): Promise<RunJobHandle> {
    this.submitted = req;
    return { jobId: 'j', runId: 'r', status: 'accepted', effectiveSeed: req.seed, requestFingerprint: 'fp', idempotentReplay: false };
  }
  async getRunStatus(runId: string): Promise<BtRunStatusView> {
    return {
      runId,
      jobId: 'j',
      status: 'completed',
      timeline: [
        { status: 'accepted', atMs: 1 },
        { status: 'queued', atMs: 2 },
        { status: 'running', atMs: 3 },
        { status: 'completed', atMs: 4 },
      ],
    };
  }
  async getRunResult(runId: string): Promise<BtRunResultSummary> {
    if (this.resultMode === 'conflict') throw new BacktesterConflictError(409, 'run_not_complete', 'not complete');
    if (this.resultMode === 'error') throw new BacktesterError(500, 'boom', 'server error');
    return {
      runId,
      status: 'completed',
      metrics: { pnl: 12, return_pct: 1.2 },
      artifactRefs: [{ artifactId: 'sha256:aa', artifactType: 'trades', availability: 'available', approxItemCount: 3 }],
      evidence: { seed: 42, contractVersion: '017.2', moduleVersions: [{ id: 'm', version: '1' }], datasetRef: 'd' },
      resultHash: 'sha256:rh',
    };
  }
  async validateModule(_req: unknown): Promise<BtValidationReport> {
    return { status: 'accepted', issues: [], executed: false };
  }
  async getCapabilities(): Promise<BtCapabilityDescriptor> {
    return { contractVersion: '017.2', artifactContractVersion: '022.1', supportedMetrics: ['pnl'], supportedModes: ['research'], maxConcurrency: 1 };
  }
  async listDatasets(): Promise<BtDatasetDescriptor[]> {
    return [{ datasetRef: 'smoke', symbols: ['BTC'], timeframe: '1m', period: { from: 'a', to: 'b' }, rowCount: 12 }];
  }
  async cancelRun(runId: string): Promise<BtRunStatusView> {
    return { runId, jobId: 'j', status: 'canceled', timeline: [{ status: 'accepted', atMs: 1 }, { status: 'canceled', atMs: 2 }], terminalCode: 'canceled' };
  }
}

const labBundle: ModuleBundle = {
  manifest: { moduleId: 'mod', moduleKind: 'hypothesis_overlay', appliesTo: 'long', entry: 'index.mjs', exports: ['apply'], capabilities: [], sdkContractVersion: 'builder-sdk-v0' },
  files: { 'index.mjs': 'export const apply = () => {};' },
  bundleHash: 'sha256:abc',
  bundleContractVersion: 'module-bundle-v1',
};

const opts: SubmitOverlayRunOptions = {
  baselineModuleRef: { id: 'base', version: 'v1' },
  run: { datasetId: 'smoke', symbols: ['BTC'], timeframe: '1m', period: { from: 'a', to: 'b' }, seed: 42 },
  correlationId: 'c1',
  resumeToken: 't1',
};

describe('HttpBacktesterAdapter', () => {
  it('submits via the client with a strategy moduleBundle + baseline moduleRef', async () => {
    const fake = new FakeClient();
    const handle = await new HttpBacktesterAdapter(fake).submitOverlayRun(labBundle, opts);
    expect(handle.status).toBe('accepted');
    expect(fake.submitted?.moduleRef).toEqual({ id: 'base', version: 'v1' });
    expect(fake.submitted?.moduleBundle?.manifest.kind).toBe('strategy');
    expect(fake.submitted?.moduleBundle?.manifest.id).toBe('mod');
    expect(fake.submitted?.correlationId).toBe('c1');
    expect(fake.submitted?.resumeToken).toBe('t1');
    expect(fake.submitted?.metrics).toEqual([]);
  });

  it('maps the timeline array → SDK timeline object', async () => {
    const view = await new HttpBacktesterAdapter(new FakeClient()).getRunStatus('r');
    expect(view.timeline.acceptedAtMs).toBe(1);
    expect(view.timeline.queuedAtMs).toBe(2);
    expect(view.timeline.startedAtMs).toBe(3);
    expect(view.timeline.terminalAtMs).toBe(4);
  });

  it('maps a completed result with an EXPLICIT baseline-only comparison (empty variant/deltas)', async () => {
    const res = await new HttpBacktesterAdapter(new FakeClient()).getRunResult('r');
    expect(res.ok).toBe(true);
    if (res.kind !== 'summary') throw new Error('expected summary');
    expect(res.summary.runKind).toBe('baseline-only');
    expect(res.summary.comparison).toBeDefined();
    expect(res.summary.comparison?.baseline.pnl).toBe(12);
    expect(res.summary.comparison?.variant).toEqual({});
    expect(res.summary.comparison?.deltas).toEqual({});
    expect(res.summary.artifactRefs[0]?.availability.status).toBe('available');
  });

  it('returns a status view (not summary) when the result is not yet available (409)', async () => {
    const fake = new FakeClient();
    fake.resultMode = 'conflict';
    const res = await new HttpBacktesterAdapter(fake).getRunResult('r');
    expect(res.kind).toBe('status');
  });

  it('wraps client errors as GatewayRunError', async () => {
    const fake = new FakeClient();
    fake.resultMode = 'error';
    await expect(new HttpBacktesterAdapter(fake).getRunResult('r')).rejects.toBeInstanceOf(GatewayRunError);
  });

  it('discovers capabilities and lists datasets', async () => {
    const adapter = new HttpBacktesterAdapter(new FakeClient());
    expect((await adapter.discover()).contractVersion).toBe('017.2');
    const datasets = await adapter.listDatasets();
    expect(datasets.datasets[0]?.datasetId).toBe('smoke');
  });
});
