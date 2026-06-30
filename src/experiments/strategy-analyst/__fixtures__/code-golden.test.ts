import { describe, it, expect } from 'vitest';
import { CODE_LONG_OI_PROFILE } from './code-golden.ts';

describe('CODE_LONG_OI_PROFILE', () => {
  it('loads the code-derived golden (direction long, high confidence, bot_code provenance)', () => {
    expect(CODE_LONG_OI_PROFILE.direction).toBe('long');
    expect(CODE_LONG_OI_PROFILE.confidence).toBeGreaterThanOrEqual(0.9);
    expect(CODE_LONG_OI_PROFILE.requiredMarketFeatures.length).toBeGreaterThan(0);
    expect(CODE_LONG_OI_PROFILE.coreIdea).toMatch(/dump|reversal|bounce/i);
  });
});
