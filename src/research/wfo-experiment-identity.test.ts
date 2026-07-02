import { describe, it, expect } from 'vitest';
import { computeWfoExperimentKey } from './wfo-experiment-identity.ts';

describe('wfo-experiment-identity', () => {
  it('is stable and distinct by baseline + bundle', () => {
    const a = computeWfoExperimentKey({ baselineExperimentId: 'e1', bundleHash: 'sha256:b' });
    const b = computeWfoExperimentKey({ baselineExperimentId: 'e1', bundleHash: 'sha256:b' });
    const c = computeWfoExperimentKey({ baselineExperimentId: 'e1', bundleHash: 'sha256:c' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
