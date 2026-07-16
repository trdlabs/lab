import { describe, it, expect } from 'vitest';
import { CONTRACT_VERSION, SDK_VERSION, SDK_CAPABILITIES } from '@trdlabs/sdk';

// Smoke test: proves the standalone @trdlabs/sdk resolves by name from the public npm registry,
// without a sibling-repo dependency, and exposes its documented root surface. The /agent gateway
// surface was cut in 0.5.0 (mcp integration retired), so this asserts only the surviving root.
describe('@trdlabs/sdk standalone package', () => {
  it('exposes the root contract + version surface', () => {
    expect(typeof CONTRACT_VERSION).toBe('string');
    expect(CONTRACT_VERSION.length).toBeGreaterThan(0);
    expect(SDK_VERSION).toBe('0.10.0');
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
});
