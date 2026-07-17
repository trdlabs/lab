import { describe, it, expect } from 'vitest';
import type {
  CapabilityDescriptor as BtCapabilityDescriptor,
  DatasetDescriptor as BtDatasetDescriptor,
  RunResultSummary as BtRunResultSummary,
  RunStatusView as BtRunStatusView,
  RunSubmitRequest as BtRunSubmitRequest,
  ValidationReport as BtValidationReport,
  RegistryDescriptor,
} from '@trdlabs/backtester-sdk/contracts';
import { createModuleManifest } from '@trdlabs/backtester-sdk/builder';
import type { RunJobHandle } from '../../ports/research-platform.port.ts';
import type { BacktesterClientLike } from './http-backtester.adapter.ts';
import { HttpBacktesterAdapter } from './http-backtester.adapter.ts';
import type { StrategyRunSubmission } from '../../ports/backtester-strategy.port.ts';

const GOLDEN = 'sha256:0be9931c' as const;
const DIFFERENT = 'sha256:deadbeef' as const;

const manifest = createModuleManifest({
  id: 'test-strategy',
  version: '1.0.0',
  kind: 'strategy',
  name: 'Test Strategy',
  summary: 'test',
  rationale: 'test',
  hooks: ['onBarClose'],
  paramsSchema: { type: 'object', additionalProperties: false },
  capabilities: { platformSdk: true },
  dataNeeds: { closedCandlesUpToCurrent: true },
});

const bundleSource = 'export default function createStrategyModule() { return { onBarClose: () => null }; }';

const submission: StrategyRunSubmission = {
  bundleBytes: new TextEncoder().encode(bundleSource),
  bundleHash: 'sha256:abc123',
  manifest,
  curatedBundleHash: 'sha256:curated',
  scope: {
    datasetRef: 'shortAfterPump-v1',
    window: { fromMs: 1700000000000, toMs: 1700010000000 },
    symbols: ['BTCUSDT'],
    timeframe: '1m',
  },
};

function makeClient(opts: {
  resultHash?: `sha256:${string}`;
  throwOn?: 'submitRun' | 'getRunStatus' | 'getRunResult';
  nonTerminal?: boolean;
}): BacktesterClientLike {
  return {
    async submitRun(_req: BtRunSubmitRequest): Promise<RunJobHandle> {
      if (opts.throwOn === 'submitRun') throw new Error('connection refused');
      return { jobId: 'j1', runId: 'r1', status: 'accepted', effectiveSeed: 0, requestFingerprint: 'fp', idempotentReplay: false };
    },
    async getRunStatus(runId: string): Promise<BtRunStatusView> {
      if (opts.throwOn === 'getRunStatus') throw new Error('timeout');
      if (opts.nonTerminal) {
        return { runId, jobId: 'j1', status: 'running', timeline: [{ status: 'accepted', atMs: 1 }, { status: 'running', atMs: 2 }] };
      }
      return {
        runId,
        jobId: 'j1',
        status: 'completed',
        timeline: [
          { status: 'accepted', atMs: 1 },
          { status: 'completed', atMs: 2 },
        ],
      };
    },
    async getRunResult(runId: string): Promise<BtRunResultSummary> {
      if (opts.throwOn === 'getRunResult') throw new Error('server error');
      return {
        runId,
        status: 'completed',
        metrics: {},
        artifactRefs: [],
        evidence: { seed: 0, contractVersion: '017.2', moduleVersions: [], datasetRef: 'shortAfterPump-v1' },
        ...(opts.resultHash !== undefined ? { resultHash: opts.resultHash } : {}),
      };
    },
    async validateModule(_req: unknown): Promise<BtValidationReport> {
      return { status: 'accepted', issues: [], executed: false };
    },
    async getCapabilities(): Promise<BtCapabilityDescriptor> {
      return { contractVersion: '017.2', artifactContractVersion: '022.1', supportedMetrics: [], supportedModes: ['research'], maxConcurrency: 1 };
    },
    async discoverRegistry(): Promise<RegistryDescriptor> {
      return { contractVersion: '017.2', baselines: [], overlays: [], riskProfiles: [], execProfiles: [], metricCatalogs: { momentum: [], overlay: [] }, overlayRunPresets: [] };
    },
    async listDatasets(): Promise<BtDatasetDescriptor[]> { return []; },
    async cancelRun(runId: string): Promise<BtRunStatusView> {
      return { runId, jobId: 'j1', status: 'canceled', timeline: [] };
    },
    async getArtifactManifest(_runId: string): Promise<{ descriptors: readonly { artifactType: string; contentHash: string; availability: string; approxItemCount?: number }[] }> {
      return { descriptors: [] };
    },
    async readArtifact(_runId: string, _artifactId: string, _opts?: { offset?: number; limit?: number }): Promise<{ page: readonly unknown[]; total: number; offset: number; nextCursor?: string }> {
      return { page: [], total: 0, offset: 0 };
    },
  };
}

describe('HttpBacktesterAdapter.submitStrategyRun', () => {
  it('returns equivalent when resultHash matches golden', async () => {
    const adapter = new HttpBacktesterAdapter(makeClient({ resultHash: GOLDEN }), { goldenResultHash: GOLDEN });
    const result = await adapter.submitStrategyRun(submission);
    expect(result.status).toBe('equivalent');
    expect(result.resultHash).toBe(GOLDEN);
  });

  it('returns divergent when resultHash differs from golden', async () => {
    const adapter = new HttpBacktesterAdapter(makeClient({ resultHash: DIFFERENT }), { goldenResultHash: GOLDEN });
    const result = await adapter.submitStrategyRun(submission);
    expect(result.status).toBe('divergent');
    expect(result.resultHash).toBe(DIFFERENT);
    expect(result.divergence?.field).toBe('result_hash');
    expect(result.divergence?.expected).toBe(GOLDEN);
    expect(result.divergence?.actual).toBe(DIFFERENT);
    expect(result.divergence?.bar).toBe(-1);
  });

  it('returns unavailable when submitRun throws', async () => {
    const adapter = new HttpBacktesterAdapter(makeClient({ throwOn: 'submitRun' }), { goldenResultHash: GOLDEN });
    const result = await adapter.submitStrategyRun(submission);
    expect(result.status).toBe('unavailable');
  });

  it('returns unavailable when getRunStatus throws', async () => {
    const adapter = new HttpBacktesterAdapter(makeClient({ throwOn: 'getRunStatus' }), { goldenResultHash: GOLDEN });
    const result = await adapter.submitStrategyRun(submission);
    expect(result.status).toBe('unavailable');
  });

  it('returns unavailable when getRunResult throws', async () => {
    const adapter = new HttpBacktesterAdapter(makeClient({ throwOn: 'getRunResult' }), { goldenResultHash: GOLDEN });
    const result = await adapter.submitStrategyRun(submission);
    expect(result.status).toBe('unavailable');
  });

  it('backward compat: existing single-arg constructor still compiles and works', async () => {
    // no opts arg → goldenResultHash is undefined; resultHash undefined too → unavailable (vacuous guard)
    const adapter = new HttpBacktesterAdapter(makeClient({}));
    const result = await adapter.submitStrategyRun(submission);
    // no configured golden → cannot prove equivalence → unavailable (not 'equivalent')
    expect(result.status).toBe('unavailable');
  });

  it('returns unavailable when poll never reaches terminal (deadline)', async () => {
    const adapter = new HttpBacktesterAdapter(
      makeClient({ nonTerminal: true }),
      { goldenResultHash: GOLDEN, maxPollMs: 30, pollIntervalMs: 5 },
    );
    const result = await adapter.submitStrategyRun(submission);
    expect(result.status).toBe('unavailable');
  });

  it('returns unavailable when backtester omits resultHash (golden set)', async () => {
    // makeClient({}) returns no resultHash → summary.resultHash is undefined
    const adapter = new HttpBacktesterAdapter(makeClient({}), { goldenResultHash: GOLDEN });
    const result = await adapter.submitStrategyRun(submission);
    expect(result.status).toBe('unavailable');
  });

  it('sends engine:strategy and correct moduleRef in the request', async () => {
    let capturedReq: BtRunSubmitRequest | undefined;
    const client = makeClient({ resultHash: GOLDEN });
    const originalSubmit = client.submitRun.bind(client);
    client.submitRun = async (req) => {
      capturedReq = req;
      return originalSubmit(req);
    };
    const adapter = new HttpBacktesterAdapter(client, { goldenResultHash: GOLDEN });
    await adapter.submitStrategyRun(submission);
    expect(capturedReq?.engine).toBe('strategy');
    expect(capturedReq?.moduleRef).toEqual({ id: 'test-strategy', version: '1.0.0' });
    expect(capturedReq?.mode).toBe('research');
    expect(capturedReq?.datasetRef).toBe('shortAfterPump-v1');
    expect(capturedReq?.symbols).toEqual(['BTCUSDT']);
    expect(capturedReq?.timeframe).toBe('1m');
    expect(capturedReq?.overlayRefs).toBeUndefined();
  });
});
