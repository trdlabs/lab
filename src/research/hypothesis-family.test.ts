// src/research/hypothesis-family.test.ts
import { describe, it, expect } from 'vitest';
import { hypothesisFamilyHint } from './hypothesis-family.ts';

describe('hypothesisFamilyHint', () => {
  it('returns the stable hypothesis: prefix over the hypothesis id when there is no lineage', () => {
    expect(hypothesisFamilyHint({ id: 'h1' })).toBe('hypothesis:h1');
  });

  it('returns the stable hypothesis: prefix over the lineage id when derivedFrom is present', () => {
    expect(hypothesisFamilyHint({ id: 'h2', derivedFrom: 'h1' })).toBe('hypothesis:h1');
  });

  it('falls back to id when derivedFrom is explicitly null', () => {
    expect(hypothesisFamilyHint({ id: 'h3', derivedFrom: null })).toBe('hypothesis:h3');
  });
});
