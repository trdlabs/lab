import { describe, it, expect } from 'vitest';
import {
  StrategyCriticInputSchema,
  StrategyCritiqueSchema,
  StrategyRefinementSchema,
} from './strategy-critic.ts';

const validCritique = {
  vulnerabilities: ['thesis assumes liquidity that may not exist'],
  selfDeception: ['treats a lagging signal as leading'],
  risks: { market: 'trend reversal', timing: 'too early', news: 'unscheduled CPI', liquidity: 'thin book', btcRegime: 'BTC-led selloff', exhaustion: 'momentum fading' },
  earlyBreakSigns: ['funding flips positive'],
  preEntryChecks: ['confirm OI rising'],
  verdict: { mainVulnerability: 'no invalidation', severity: 'high', badIdeaOrBadTiming: 'bad_timing', whatWouldStrengthen: 'add a regime filter' },
};

describe('strategy-critic schemas', () => {
  it('accepts a valid critic input (reuses the analyst input shape)', () => {
    const r = StrategyCriticInputSchema.safeParse({ kind: 'manual_description', content: 'short after a pump' });
    expect(r.success).toBe(true);
  });

  it('rejects a critic input with empty content', () => {
    expect(StrategyCriticInputSchema.safeParse({ kind: 'article', content: '' }).success).toBe(false);
  });

  it('round-trips a valid critique', () => {
    expect(StrategyCritiqueSchema.safeParse(validCritique).success).toBe(true);
  });

  it('rejects a critique with an out-of-enum severity', () => {
    const bad = { ...validCritique, verdict: { ...validCritique.verdict, severity: 'extreme' } };
    expect(StrategyCritiqueSchema.safeParse(bad).success).toBe(false);
  });

  it('refinement extends the critique with improvedStrategyText + required changeLog', () => {
    const ok = StrategyRefinementSchema.safeParse({ ...validCritique, improvedStrategyText: 'short after a >10% pump in 20m, only when BTC is range-bound; invalidate if funding flips', changeLog: ['added BTC-regime filter'] });
    expect(ok.success).toBe(true);
    const emptyLog = StrategyRefinementSchema.safeParse({ ...validCritique, improvedStrategyText: 'x', changeLog: [] });
    expect(emptyLog.success).toBe(true); // changeLog required but can be empty array
    const noLog = StrategyRefinementSchema.safeParse({ ...validCritique, improvedStrategyText: 'x' });
    expect(noLog.success).toBe(false); // changeLog is now required
    const missing = StrategyRefinementSchema.safeParse(validCritique); // no improvedStrategyText, no changeLog
    expect(missing.success).toBe(false);
  });
});
