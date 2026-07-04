import { describe, it, expect } from 'vitest';
import { CONTRACT_VERSION } from '@trdlabs/sdk';
import { MockResearchPlatformAdapter } from './mock-research-platform.adapter.ts';
import { assembleBundle, SDK_CONTRACT_VERSION, type ModuleManifest } from '../../domain/module-bundle.ts';

describe('MockResearchPlatformAdapter', () => {
  it('discover() returns a contract-compatible descriptor', async () => {
    const a = new MockResearchPlatformAdapter();
    const d = await a.discover();
    expect(d.contractVersion).toBe(CONTRACT_VERSION);
    expect(d.supportedContractVersions).toContain(CONTRACT_VERSION);
    expect(Array.isArray(d.marketDataKinds)).toBe(true);
    expect(Array.isArray(d.metricCatalog)).toBe(true);
  });

  it('listDatasets() returns a datasets array', async () => {
    const a = new MockResearchPlatformAdapter();
    const r = await a.listDatasets();
    expect(Array.isArray(r.datasets)).toBe(true);
  });
});

const manifest: ModuleManifest = {
  moduleId: 'm1', moduleKind: 'hypothesis_overlay', appliesTo: 'long',
  entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: SDK_CONTRACT_VERSION,
};

describe('MockResearchPlatformAdapter.validateModule', () => {
  it('returns an accepted, non-executed report', async () => {
    const adapter = new MockResearchPlatformAdapter();
    const report = await adapter.validateModule(assembleBundle(manifest, { 'index.ts': 'export const overlay = {};' }));
    expect(report.status).toBe('accepted');
    expect(report.executed).toBe(false);
    expect(report.issues).toEqual([]);
  });
});

describe('MockResearchPlatformAdapter.submitStrategyResearchRun', () => {
  const bundle = { bytes: new Uint8Array(), source: '', manifest: { id: 'mod_x', version: '1', kind: 'strategy' } as any, bundleHash: 'sha256:h' } as any;
  const opts = {
    run: { datasetId: 'mock-ds-1', symbols: ['ESPORTSUSDT'], timeframe: '1h', period: { from: '2026-06-12', to: '2026-06-18' }, seed: 42 },
    correlationId: 'sanity',
    metrics: ['netPnlUsd'],
  };

  it('returns a pollable handle resolvable via getRunStatus/getRunResult, with a metrics-only (no comparison) summary', async () => {
    const adapter = new MockResearchPlatformAdapter();
    const handle = await adapter.submitStrategyResearchRun(bundle, opts);
    expect(handle.runId).toBeTruthy();
    expect(handle.status).toBe('accepted');
    expect(handle.effectiveSeed).toBe(42);
    expect(handle.correlationId).toBe('sanity');

    const view = await adapter.getRunStatus(handle.runId);
    expect(['completed', 'running', 'submitted']).toContain(view.status);

    const result = await adapter.getRunResult(handle.runId);
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'summary') {
      expect(result.summary.runId).toBe(handle.runId);
      expect(result.summary.metrics).toBeTruthy();
      expect(Object.keys(result.summary.metrics).length).toBeGreaterThan(0);
      expect(result.summary.comparison).toBeUndefined();
    } else {
      expect.fail('expected getRunResult to resolve to a summary');
    }
  });

  it('strategy getRunResult varies metrics deterministically by params (empty params unchanged)', async () => {
    const a = new MockResearchPlatformAdapter();
    const runA = await a.submitStrategyResearchRun(bundle, { ...opts, params: { 'dump.minDropPct': 2 } });
    const runB = await a.submitStrategyResearchRun(bundle, { ...opts, params: { 'dump.minDropPct': 5 } });
    const resA = await a.getRunResult(runA.runId);
    const resB = await a.getRunResult(runB.runId);
    if (resA.kind !== 'summary' || resB.kind !== 'summary') throw new Error('expected summaries');
    expect(resA.summary.metrics).not.toEqual(resB.summary.metrics); // distinct points differ

    const runAgain = await a.submitStrategyResearchRun(bundle, { ...opts, params: { 'dump.minDropPct': 2 } });
    const again = await a.getRunResult(runAgain.runId);
    if (again.kind !== 'summary') throw new Error('expected summary');
    expect(again.summary.metrics).toEqual(resA.summary.metrics); // same params → same metrics (deterministic)
  });

  it('empty params keep the current fixed baseline metrics (zero-diff)', async () => {
    const a = new MockResearchPlatformAdapter();
    const handle = await a.submitStrategyResearchRun(bundle, opts);
    const result = await a.getRunResult(handle.runId);
    if (result.kind !== 'summary') throw new Error('expected summary');
    expect(result.summary.metrics).toEqual({
      pnl: 1500, sharpe: 1.6, max_drawdown: 0.14, win_rate: 0.58, total_trades: 42, profit_factor: 2.1, top_trade_contribution_pct: 28,
    });
  });
});
