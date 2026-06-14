import { describe, it, expect } from 'vitest';
import { CONTRACT_VERSION } from '@trading-platform/sdk';
import { MockResearchPlatformAdapter } from './mock-research-platform.adapter.ts';

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
