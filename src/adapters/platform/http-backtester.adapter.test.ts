import { describe, it, expect } from 'vitest';
import { BacktesterConflictError, BacktesterError } from '@trading-backtester/sdk/client';
import type {
  CapabilityDescriptor as BtCapabilityDescriptor,
  DatasetDescriptor as BtDatasetDescriptor,
  RunResultSummary as BtRunResultSummary,
  RunStatusView as BtRunStatusView,
  RunSubmitRequest as BtRunSubmitRequest,
  ValidationReport as BtValidationReport,
  ModuleValidateRequest as BtModuleValidateRequest,
  RegistryDescriptor,
} from '@trading-backtester/sdk/contracts';
import type { RunJobHandle, SubmitOverlayRunOptions, SubmitStrategyResearchRunOptions } from '../../ports/research-platform.port.ts';
import type { ModuleBundle } from '../../domain/module-bundle.ts';
import type { AssembledStrategyBundle } from '../../domain/strategy-bundle.ts';
import { GatewayRunError } from './gateway-errors.ts';
import { HttpBacktesterAdapter, type BacktesterClientLike } from './http-backtester.adapter.ts';

class FakeClient implements BacktesterClientLike {
  submitted?: BtRunSubmitRequest;
  resultMode: 'summary' | 'conflict' | 'error' | 'overlay-summary' = 'summary';

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
    if (this.resultMode === 'overlay-summary') {
      return {
        runId,
        status: 'completed',
        metrics: { pnl: 15, return_pct: 1.5 },
        artifactRefs: [],
        evidence: { seed: 42, contractVersion: '017.2', moduleVersions: [], datasetRef: 'd' },
        comparison: {
          baselineRunId: 'base-r',
          variants: [{
            runId: 'var-r',
            overlayRefs: [],
            metricDeltas: {
              pnl: { baseline: 10, variant: 15, delta: 5 },
              return_pct: { baseline: 1.0, variant: 1.5, delta: 0.5 },
            },
            tradeOutcomeChanged: false,
            overlayEffectsSummary: { pass: 10, annotate: 2, patch: 1, veto: 0 },
          }],
        },
      };
    }
    return {
      runId,
      status: 'completed',
      metrics: { pnl: 12, return_pct: 1.2 },
      artifactRefs: [{ artifactId: 'sha256:aa', artifactType: 'trades', availability: 'available', approxItemCount: 3 }],
      evidence: { seed: 42, contractVersion: '017.2', moduleVersions: [{ id: 'm', version: '1' }], datasetRef: 'd' },
      resultHash: 'sha256:rh',
    };
  }
  async validateModule(_req: BtModuleValidateRequest): Promise<BtValidationReport> {
    return { status: 'accepted', issues: [], executed: false };
  }
  async getCapabilities(): Promise<BtCapabilityDescriptor> {
    return { contractVersion: '017.2', artifactContractVersion: '022.1', supportedMetrics: ['pnl'], supportedModes: ['research'], maxConcurrency: 1 };
  }
  async discoverRegistry(): Promise<RegistryDescriptor> {
    return {
      contractVersion: '017.2',
      baselines: [{ id: 'base', version: 'v1' }],
      overlays: [],
      riskProfiles: [{ id: 'risk', version: 'v1' }],
      execProfiles: [{ id: 'exec', version: 'v1' }],
      metricCatalogs: { momentum: ['pnl'], overlay: ['pnl'] },
      overlayRunPresets: [{
        id: 'default-overlay',
        baselineRef: { id: 'base', version: 'v1' },
        riskProfileRef: { id: 'risk', version: 'v1' },
        executionProfileRef: { id: 'exec', version: 'v1' },
        metrics: ['pnl'],
      }],
    };
  }
  async listDatasets(): Promise<BtDatasetDescriptor[]> {
    return [{ datasetRef: 'smoke', symbols: ['BTC'], timeframe: '1m', period: { from: 'a', to: 'b' }, rowCount: 12 }];
  }
  async cancelRun(runId: string): Promise<BtRunStatusView> {
    return { runId, jobId: 'j', status: 'canceled', timeline: [{ status: 'accepted', atMs: 1 }, { status: 'canceled', atMs: 2 }], terminalCode: 'canceled' };
  }
  async getArtifactManifest(_runId: string): Promise<{ descriptors: readonly { artifactType: string; contentHash: string; availability: string; approxItemCount?: number }[] }> {
    return { descriptors: [] };
  }
  async readArtifact(_runId: string, _artifactId: string, _opts?: { offset?: number; limit?: number }): Promise<{ page: readonly unknown[]; total: number; offset: number; nextCursor?: string }> {
    return { page: [], total: 0, offset: 0 };
  }
}

const labBundle: ModuleBundle = {
  manifest: { moduleId: 'mod', moduleKind: 'hypothesis_overlay', appliesTo: 'long', entry: 'index.mjs', exports: ['apply'], capabilities: [], sdkContractVersion: 'builder-sdk-v0' },
  files: { 'index.mjs': 'export const apply = () => {};' },
  bundleHash: 'sha256:abc',
  bundleContractVersion: 'module-bundle-v1',
};

const opts: SubmitOverlayRunOptions = {
  target: { kind: 'registry_preset' },
  run: { datasetId: 'smoke', symbols: ['BTC'], timeframe: '1m', period: { from: 'a', to: 'b' }, seed: 42 },
  correlationId: 'c1',
  resumeToken: 't1',
};

const strategyBundle: AssembledStrategyBundle = {
  bytes: new Uint8Array(),
  source: '',
  manifest: { id: 'strat_x', version: '2', kind: 'strategy' } as any,
  bundleHash: 'sha256:sb',
};

const strategyOpts: SubmitStrategyResearchRunOptions = {
  run: { datasetId: 'smoke', symbols: ['BTC'], timeframe: '1m', period: { from: 'a', to: 'b' }, seed: 42 },
  correlationId: 'c2',
  metrics: ['pnl', 'sharpe'],
  resumeToken: 't2',
  workflowId: 'wf1',
  callbackUrl: 'https://cb.example/hook',
};

describe('HttpBacktesterAdapter', () => {
  it('submits via the client with an overlay moduleBundle + baseline moduleRef', async () => {
    const fake = new FakeClient();
    const handle = await new HttpBacktesterAdapter(fake).submitOverlayRun(labBundle, opts);
    expect(handle.status).toBe('accepted');
    expect(fake.submitted?.moduleRef).toEqual({ id: 'base', version: 'v1' });
    expect(fake.submitted?.moduleBundle?.manifest.kind).toBe('overlay');
    expect(fake.submitted?.moduleBundle?.manifest.id).toBe('mod');
    expect(fake.submitted?.correlationId).toBe('c1');
    expect(fake.submitted?.resumeToken).toBe('t1');
    expect(fake.submitted?.metrics).toEqual(['pnl']);
  });

  it('rejects a baseline_ref target — the backtester integration requires a registry_preset', async () => {
    const fake = new FakeClient();
    await expect(
      new HttpBacktesterAdapter(fake).submitOverlayRun(labBundle, { ...opts, target: { kind: 'baseline_ref', moduleRef: { id: 'x', version: 'v1' } } }),
    ).rejects.toBeInstanceOf(GatewayRunError);
    expect(fake.submitted).toBeUndefined();
  });

  it('a registry_preset submission carries overlayRefs + risk/exec profiles + non-empty preset metrics', async () => {
    const fake = new FakeClient();
    await new HttpBacktesterAdapter(fake).submitOverlayRun(labBundle, opts);
    expect(fake.submitted?.moduleRef).toEqual({ id: 'base', version: 'v1' });
    expect(fake.submitted?.overlayRefs).toEqual([{ id: 'mod', version: '1.0.0' }]);
    expect(fake.submitted?.riskProfileRef).toEqual({ id: 'risk', version: 'v1' });
    expect(fake.submitted?.executionProfileRef).toEqual({ id: 'exec', version: 'v1' });
    expect(fake.submitted?.metrics).toEqual(['pnl']);
    expect((fake.submitted?.metrics ?? []).length).toBeGreaterThan(0);
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

  it('submitOverlayRun sends engine:overlay in the submit request', async () => {
    const fake = new FakeClient();
    await new HttpBacktesterAdapter(fake).submitOverlayRun(labBundle, opts);
    expect(fake.submitted?.engine).toBe('overlay');
  });

  it('submitStrategyResearchRun sends engine:strategy with the bundle manifest as moduleRef, the run config, and passthrough resumeToken/workflowId/callbackUrl', async () => {
    const fake = new FakeClient();
    const handle = await new HttpBacktesterAdapter(fake).submitStrategyResearchRun(strategyBundle, strategyOpts);
    expect(handle.status).toBe('accepted');
    expect(fake.submitted?.engine).toBe('strategy');
    expect(fake.submitted?.moduleRef).toEqual({ id: 'strat_x', version: '2' });
    expect(fake.submitted?.moduleBundle?.manifest.kind).toBe('strategy');
    expect(fake.submitted?.metrics).toEqual(['pnl', 'sharpe']);
    expect(fake.submitted?.period).toEqual({ from: 'a', to: 'b' });
    expect(fake.submitted?.symbols).toEqual(['BTC']);
    expect(fake.submitted?.seed).toBe(42);
    expect(fake.submitted?.datasetRef).toBe('smoke');
    expect(fake.submitted?.resumeToken).toBe('t2');
    expect(fake.submitted?.workflowId).toBe('wf1');
    expect(fake.submitted?.callbackUrl).toBe('https://cb.example/hook');
  });

  it('submitStrategyResearchRun binds the platform-default risk + execution profile refs (from the resolved preset) — the strategy engine rejects a run without them', async () => {
    // moduleRef stays the STRATEGY bundle (not the preset baseline); only risk/exec refs are borrowed
    // from the sole preset, which advertises the platform defaults the strategy inline-registry registers.
    const fake = new FakeClient();
    await new HttpBacktesterAdapter(fake).submitStrategyResearchRun(strategyBundle, strategyOpts);
    expect(fake.submitted?.moduleRef).toEqual({ id: 'strat_x', version: '2' });
    expect(fake.submitted?.riskProfileRef).toEqual({ id: 'risk', version: 'v1' });
    expect(fake.submitted?.executionProfileRef).toEqual({ id: 'exec', version: 'v1' });
  });

  it('submitStrategyResearchRun puts non-empty opts.params into request.params (and omits when empty)', async () => {
    const fake = new FakeClient();
    await new HttpBacktesterAdapter(fake).submitStrategyResearchRun(strategyBundle, {
      ...strategyOpts, params: { 'dump.minDropPct': 2.5, 'entry.fastBouncePct': 0.4 },
    });
    expect(fake.submitted?.params).toEqual({ 'dump.minDropPct': 2.5, 'entry.fastBouncePct': 0.4 });

    const fake2 = new FakeClient();
    await new HttpBacktesterAdapter(fake2).submitStrategyResearchRun(strategyBundle, { ...strategyOpts, params: {} });
    expect(fake2.submitted && 'params' in fake2.submitted).toBe(false);
  });

  it('maps an overlay result: runKind=baseline-vs-variant, comparison populated from metricDeltas', async () => {
    const fake = new FakeClient();
    fake.resultMode = 'overlay-summary';
    const res = await new HttpBacktesterAdapter(fake).getRunResult('r');
    expect(res.ok).toBe(true);
    if (res.kind !== 'summary') throw new Error('expected summary');
    expect(res.summary.runKind).toBe('baseline-vs-variant');
    expect(res.summary.comparison?.baseline.pnl).toBe(10);
    expect(res.summary.comparison?.variant.pnl).toBe(15);
    expect(res.summary.comparison?.deltas.pnl).toBe(5);
  });
});
