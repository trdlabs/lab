import { describe, it, expect } from 'vitest';
import { computeBundleHash, getAuthoringDoc } from '@trdlabs/backtester-sdk/builder';

describe('sdk strategy authoring surface (0.3.0)', () => {
  it('computeBundleHash returns sha256:hex over raw bytes', () => {
    const h = computeBundleHash(new TextEncoder().encode('x'));
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it('getAuthoringDoc("strategy") describes createStrategyModule', () => {
    expect(getAuthoringDoc('strategy')).toContain('createStrategyModule');
  });
});
