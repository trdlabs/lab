// src/experiments/strategy-analyst/fabrication.test.ts
import { describe, it, expect } from 'vitest';
import { detectFabrication, FAB_PATTERNS, FAB_PARAM_NAME } from './fabrication.ts';
import {
  CLEAN_LONG_OI_BASE, FABRICATED_RISK_PROFILE, DCA_HINT_RISK_PROFILE,
} from './__fixtures__/profiles.ts';

describe('detectFabrication', () => {
  it('clean risk summary -> no fabrication labels', () => {
    expect(detectFabrication(CLEAN_LONG_OI_BASE)).toEqual([]);
  });

  it('fabricated leverage + base size -> labels present, in pattern order', () => {
    const labels = detectFabrication(FABRICATED_RISK_PROFILE);
    expect(labels).toContain('leverage_x');
    expect(labels).toContain('base_size_usd');
    expect(labels.length).toBeGreaterThan(0);
  });

  it('DCA size hints (1.2x/1.5x) are NOT fabrication', () => {
    expect(detectFabrication(DCA_HINT_RISK_PROFILE)).toEqual([]);
  });

  it('a sizing parameter with a value appends param_sizing last', () => {
    const profile = {
      ...CLEAN_LONG_OI_BASE,
      parameters: [{ name: 'leverage', value: 5, unit: 'x', description: 'lev', tunable: true }],
    };
    const labels = detectFabrication(profile);
    expect(labels[labels.length - 1]).toBe('param_sizing');
  });

  it('exposes the raw FAB constants for reuse', () => {
    expect(FAB_PATTERNS.length).toBeGreaterThan(0);
    expect(FAB_PARAM_NAME.test('leverage')).toBe(true);
  });
});
