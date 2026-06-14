import { describe, it, expect } from 'vitest';
import { CONTRACT_VERSION } from '@trading-platform/sdk';
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
