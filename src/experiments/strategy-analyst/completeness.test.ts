// src/experiments/strategy-analyst/completeness.test.ts
import { describe, it, expect } from 'vitest';
import { scoreCompleteness, UNKNOWNS_CAP } from './completeness.ts';
import type { ScoreResult } from './types.ts';
import { GOOD_LONG_OI_PROFILE, GOOD_SHORT_PUMP_PROFILE } from './__fixtures__/profiles.ts';

function checkById(r: ScoreResult, id: string) {
  const c = r.checks.find((x) => x.id === id);
  if (!c) throw new Error(`check ${id} not found`);
  return c;
}

describe('scoreCompleteness — gates', () => {
  it('schema-invalid raw: schemaValid false, score 0, FAIL', () => {
    const r = scoreCompleteness({ not: 'a profile' }, { expectedDirection: 'long' });
    expect(r.gates.schemaValid).toBe(false);
    expect(r.gates.directionMatches).toBe(false);
    expect(r.score).toBe(0);
    expect(r.checks).toEqual([]);
    expect(r.verdict).toBe('FAIL');
  });

  it('direction mismatch: directionMatches false, verdict FAIL even with high score', () => {
    const r = scoreCompleteness(GOOD_LONG_OI_PROFILE, { expectedDirection: 'short' });
    expect(r.gates.schemaValid).toBe(true);
    expect(r.gates.directionMatches).toBe(false);
    expect(r.score).toBeGreaterThanOrEqual(0.99);
    expect(r.verdict).toBe('FAIL');
  });
});

describe('scoreCompleteness — complete matching-direction profiles PASS', () => {
  it('long profile, expectedDirection long -> PASS, score ~1', () => {
    const r = scoreCompleteness(GOOD_LONG_OI_PROFILE, { expectedDirection: 'long' });
    expect(r.gates).toEqual({ schemaValid: true, directionMatches: true });
    expect(r.score).toBeGreaterThanOrEqual(0.99);
    expect(r.verdict).toBe('PASS');
  });

  it('short profile, expectedDirection short -> PASS, score ~1', () => {
    const r = scoreCompleteness(GOOD_SHORT_PUMP_PROFILE, { expectedDirection: 'short' });
    expect(r.gates).toEqual({ schemaValid: true, directionMatches: true });
    expect(r.score).toBeGreaterThanOrEqual(0.99);
    expect(r.verdict).toBe('PASS');
  });
});

describe('scoreCompleteness — structural checks miss', () => {
  it('empty entryConditions -> has_entry misses', () => {
    const r = scoreCompleteness({ ...GOOD_SHORT_PUMP_PROFILE, entryConditions: [] }, { expectedDirection: 'short' });
    expect(checkById(r, 'has_entry').contribution).toBe(0);
  });

  it('empty exitConditions -> has_exit misses', () => {
    const r = scoreCompleteness({ ...GOOD_LONG_OI_PROFILE, exitConditions: [] }, { expectedDirection: 'long' });
    expect(checkById(r, 'has_exit').contribution).toBe(0);
  });

  it('empty requiredMarketFeatures -> has_market_features misses', () => {
    const r = scoreCompleteness({ ...GOOD_LONG_OI_PROFILE, requiredMarketFeatures: [] }, { expectedDirection: 'long' });
    expect(checkById(r, 'has_market_features').contribution).toBe(0);
  });

  it('unknowns over cap -> unknowns_bounded misses', () => {
    const tooMany = Array.from({ length: UNKNOWNS_CAP + 1 }, (_, i) => `unknown ${i}`);
    const r = scoreCompleteness({ ...GOOD_SHORT_PUMP_PROFILE, unknowns: tooMany }, { expectedDirection: 'short' });
    expect(checkById(r, 'unknowns_bounded').contribution).toBe(0);
  });

  it('fabricated risk text -> no_fabrication misses with labels (long and short)', () => {
    const fabLong = scoreCompleteness(
      { ...GOOD_LONG_OI_PROFILE, riskManagementSummary: 'Use 10x leverage with a base order size of $100 per entry.' },
      { expectedDirection: 'long' },
    );
    const cLong = checkById(fabLong, 'no_fabrication');
    expect(cLong.contribution).toBe(0);
    expect(cLong.matched.length).toBeGreaterThan(0);

    const fabShort = scoreCompleteness(
      { ...GOOD_SHORT_PUMP_PROFILE, riskManagementSummary: 'Use 10x leverage with a base order size of $100 per entry.' },
      { expectedDirection: 'short' },
    );
    expect(checkById(fabShort, 'no_fabrication').contribution).toBe(0);
  });
});

describe('scoreCompleteness — threshold', () => {
  it('default threshold is DEFAULT_THRESHOLD (0.8)', () => {
    expect(scoreCompleteness(GOOD_LONG_OI_PROFILE, { expectedDirection: 'long' }).threshold).toBe(0.8);
  });
  it('respects an explicit threshold', () => {
    const r = scoreCompleteness(GOOD_SHORT_PUMP_PROFILE, { expectedDirection: 'short', threshold: 0.5 });
    expect(r.threshold).toBe(0.5);
  });
});
