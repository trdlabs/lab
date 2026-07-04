import { describe, it, expect } from 'vitest';
import { deriveProposedRiskProfile } from './proposed-risk-profile.ts';

describe('deriveProposedRiskProfile (Option B: tuned stops over neutral defaults)', () => {
  it('returns undefined when no recognized tuned stop is present', () => {
    expect(deriveProposedRiskProfile({})).toBeUndefined();
    expect(deriveProposedRiskProfile({ tunedParams: { dumpPct: 8, oi_threshold: 5 } })).toBeUndefined();
    expect(deriveProposedRiskProfile({ profileParams: [{ name: 'dump.minDropPct', value: 10 }] })).toBeUndefined();
  });

  it('overrides stops from tunedParams (canonical + aliased names), keeps runner-owned sizing/dca default', () => {
    const p = deriveProposedRiskProfile({ tunedParams: { 'tpLadder.tp1Pct': 4, 'risk.hardStopPct': 8, maxHoldMin: 90 } }) as any;
    expect(p).toBeDefined();
    // full shape — platform looksLikeRiskProfile (087) requires all three sections
    expect(Object.keys(p).sort()).toEqual(['dca', 'sizing', 'stops']);
    expect(p.stops.tp1Pct).toBe(4);
    expect(p.stops.hardStopPct).toBe(8); // aliased 'risk.hardStopPct'
    expect(p.stops.maxHoldMin).toBe(90);
    expect(p.stops.tp2Pct).toBe(5); // not tuned → default
    expect(p.sizing.baseOrderUsd).toBe(100); // runner-owned → neutral default
    expect(p.dca.maxCount).toBe(2);
  });

  it('falls back to profileParams when tunedParams absent; coerces numeric strings', () => {
    const p = deriveProposedRiskProfile({ profileParams: [{ name: 'exit.tpPct', value: '3' }, { name: 'hardStopPct', value: 15 }] }) as any;
    expect(p.stops.tp1Pct).toBe(3);
    expect(p.stops.hardStopPct).toBe(15);
  });

  it('tunedParams take precedence over profileParams for the same field', () => {
    const p = deriveProposedRiskProfile({ tunedParams: { hardStopPct: 7 }, profileParams: [{ name: 'hardStopPct', value: 20 }] }) as any;
    expect(p.stops.hardStopPct).toBe(7);
  });

  it('ignores non-numeric / non-finite values', () => {
    expect(deriveProposedRiskProfile({ tunedParams: { hardStopPct: 'abc' } })).toBeUndefined();
    expect(deriveProposedRiskProfile({ tunedParams: { hardStopPct: null } })).toBeUndefined();
  });
});
