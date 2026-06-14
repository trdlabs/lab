import { describe, it, expect } from 'vitest';
import { CONTRACT_VERSION, SDK_VERSION, SDK_CAPABILITIES } from '@trading-platform/sdk';
import { discover, listDatasets } from '@trading-platform/sdk/agent';

// SP-8 smoke test: proves the standalone @trading-platform/sdk resolves by name (from the
// vendored tarball, no sibling repo) and exposes its documented public surface — no gateway needed.
// Imports ONLY confirmed public exports; if the standalone SDK renames any, adjust to the real API.
describe('@trading-platform/sdk standalone package', () => {
  it('exposes the root contract + version surface', () => {
    expect(typeof CONTRACT_VERSION).toBe('string');
    expect(CONTRACT_VERSION.length).toBeGreaterThan(0);
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('declares all capabilities absent by construction', () => {
    expect(SDK_CAPABILITIES).toMatchObject({
      live: false,
      execution: false,
      credentials: false,
      ingestion: false,
      rawStorage: false,
    });
  });

  it('exposes the agent workflow functions', () => {
    expect(typeof discover).toBe('function');
    expect(typeof listDatasets).toBe('function');
  });
});
