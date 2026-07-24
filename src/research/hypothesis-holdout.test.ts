// src/research/hypothesis-holdout.test.ts
import { describe, it, expect } from 'vitest';
import { resolveHypothesisHoldoutMode } from './hypothesis-holdout.ts';
import type { HypothesisHoldoutMode } from './hypothesis-holdout.ts';

describe('resolveHypothesisHoldoutMode', () => {
  it("defaults to 'off' on unset/empty", () => {
    expect(resolveHypothesisHoldoutMode(undefined)).toBe('off');
    expect(resolveHypothesisHoldoutMode('')).toBe('off');
  });

  it("accepts 'off' and 'log'", () => {
    expect(resolveHypothesisHoldoutMode('off')).toBe('off');
    expect(resolveHypothesisHoldoutMode('log')).toBe('log');
  });

  it("rejects 'enforce' (deferred until battery calibration closes)", () => {
    expect(() => resolveHypothesisHoldoutMode('enforce')).toThrow(/enforce/);
    expect(() => resolveHypothesisHoldoutMode('enforce')).toThrow(/battery-policy/);
  });

  it('rejects unknown values fail-closed (deploy typo, not a request for the default)', () => {
    expect(() => resolveHypothesisHoldoutMode('LOG')).toThrow();
    expect(() => resolveHypothesisHoldoutMode('on')).toThrow();
  });

  it('return type narrows to the declared mode union', () => {
    const mode: HypothesisHoldoutMode = resolveHypothesisHoldoutMode('log');
    expect(mode).toBe('log');
  });
});
