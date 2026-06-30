// src/experiments/strategy-analyst/scoring.test.ts
import { describe, it, expect } from 'vitest';
import { scoreProfile } from './scoring.ts';
import {
  CLEAN_LONG_OI_BASE, SHORT_DIRECTION_PROFILE, FABRICATED_RISK_PROFILE,
  DCA_HINT_RISK_PROFILE, MISSING_TP2_PROFILE, POSMGMT_IN_SUMMARY_PROFILE, RU_PROFILE,
} from './__fixtures__/profiles.ts';

function checkById(r: ReturnType<typeof scoreProfile>, id: string) {
  const c = r.checks.find((x) => x.id === id);
  if (!c) throw new Error(`check ${id} not found`);
  return c;
}

describe('scoreProfile — gates', () => {
  it('schema-invalid raw object: schemaValid false, score 0, verdict FAIL', () => {
    const r = scoreProfile({ not: 'a profile' });
    expect(r.gates.schemaValid).toBe(false);
    expect(r.gates.directionLong).toBe(false);
    expect(r.score).toBe(0);
    expect(r.checks).toEqual([]);
    expect(r.verdict).toBe('FAIL');
  });

  it('direction !== long: gate fails, verdict FAIL even if checks score high', () => {
    const r = scoreProfile(SHORT_DIRECTION_PROFILE);
    expect(r.gates.schemaValid).toBe(true);
    expect(r.gates.directionLong).toBe(false);
    expect(r.score).toBeGreaterThan(0.5); // checks still computed for diagnostics
    expect(r.verdict).toBe('FAIL');
  });
});

describe('scoreProfile — positive checks', () => {
  it('good profile passes all checks (score ~1) and verdict PASS', () => {
    const r = scoreProfile(CLEAN_LONG_OI_BASE);
    expect(r.gates).toEqual({ schemaValid: true, directionLong: true });
    expect(r.score).toBeGreaterThanOrEqual(0.99);
    expect(r.verdict).toBe('PASS');
  });

  it('missing TP2 -> exitConditions check partial (3 of 4 buckets)', () => {
    const r = scoreProfile(MISSING_TP2_PROFILE);
    const c = checkById(r, 'exit_ladder');
    expect(c.bucketsHit).toBe(3);
    expect(c.bucketCount).toBe(4);
    expect(c.contribution).toBeCloseTo((3 / 4) * 0.2, 5);
  });

  it('DCA/BE only in summary -> positionMgmt check hits via fallback', () => {
    const r = scoreProfile(POSMGMT_IN_SUMMARY_PROFILE);
    const c = checkById(r, 'position_mgmt');
    expect(c.bucketsHit).toBe(2);
  });

  it('Russian-only phrasing still matches synonym buckets', () => {
    const r = scoreProfile(RU_PROFILE);
    expect(r.score).toBeGreaterThanOrEqual(0.99);
    expect(r.verdict).toBe('PASS');
  });
});

describe('scoreProfile — negative risk check (5)', () => {
  it('clean risk summary -> full credit', () => {
    const c = checkById(scoreProfile(CLEAN_LONG_OI_BASE), 'risk_no_fabrication');
    expect(c.contribution).toBeCloseTo(0.15, 5);
    expect(c.matched).toEqual([]);
  });

  it('fabricated leverage + base size -> zero credit', () => {
    const c = checkById(scoreProfile(FABRICATED_RISK_PROFILE), 'risk_no_fabrication');
    expect(c.contribution).toBe(0);
    expect(c.matched.length).toBeGreaterThan(0);
  });

  it('DCA size hints (1.2x/1.5x) do NOT count as fabrication', () => {
    const c = checkById(scoreProfile(DCA_HINT_RISK_PROFILE), 'risk_no_fabrication');
    expect(c.contribution).toBeCloseTo(0.15, 5);
  });
});

describe('scoreProfile — threshold', () => {
  it('score below threshold -> FAIL even with gates passing', () => {
    const r = scoreProfile(MISSING_TP2_PROFILE, { threshold: 0.999 });
    expect(r.gates).toEqual({ schemaValid: true, directionLong: true });
    expect(r.verdict).toBe('FAIL');
  });
  it('default threshold is 0.8', () => {
    expect(scoreProfile(CLEAN_LONG_OI_BASE).threshold).toBe(0.8);
  });
});

describe('bucket matching robustness', () => {
  it('the oi token does not match inside unrelated words', () => {
    // "avoid"/"point" contain the substring "oi" but must not satisfy the OI bucket
    const profile = { ...CLEAN_LONG_OI_BASE, requiredMarketFeatures: ['ohlcv', 'avoid the point', 'liquidations'] };
    const c = checkById(scoreProfile(profile), 'market_features');
    expect(c.bucketsHit).toBe(2); // ohlcv + liquidations, NOT oi
  });
});
