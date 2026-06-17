// src/experiments/intent-classifier/scoring.test.ts
import { describe, it, expect } from 'vitest';
import { scoreCase, scoreRun, DEFAULT_THRESHOLD } from './scoring.ts';
import type { EvalCase, CaseResult } from './types.ts';

function evalCase(over: Partial<EvalCase> & { expect: EvalCase['expect'] }): EvalCase {
  return { id: 'c1', lang: 'ru', message: 'msg', ...over };
}

describe('scoreCase — schema gate (ChatIntentSchema, the guard trust boundary)', () => {
  it('marks a well-formed matching intent as schemaValid + intentMatch', () => {
    const r = scoreCase({ intent: 'help', confidence: 0.9 }, evalCase({ expect: { intent: 'help' } }), 12);
    expect(r.schemaValid).toBe(true);
    expect(r.actualIntent).toBe('help');
    expect(r.intentMatch).toBe(true);
    expect(r.error).toBeNull();
    expect(r.latencyMs).toBe(12);
  });

  it('records a mismatch when the intent differs from expected', () => {
    const r = scoreCase({ intent: 'out_of_scope', confidence: 0.9 }, evalCase({ expect: { intent: 'help' } }), 0);
    expect(r.schemaValid).toBe(true);
    expect(r.actualIntent).toBe('out_of_scope');
    expect(r.intentMatch).toBe(false);
  });

  it('rejects an unknown intent value (enum) but still surfaces it as a visible miss', () => {
    const r = scoreCase({ intent: 'totally.made.up', confidence: 0.9 }, evalCase({ expect: { intent: 'help' } }), 0);
    expect(r.schemaValid).toBe(false);
    expect(r.actualIntent).toBe('totally.made.up'); // best-effort visible, not a bald null
    expect(r.intentMatch).toBe(false);
    expect(r.error?.type).toBe('schema');
  });

  it('counts a correct intent even when another field fails the enum (intent vs schema split)', () => {
    // model returned the right intent but entityRef "from_message" (invalid enum) -> still a
    // schema-invalid object, but the intent itself matched. intentAccuracy must credit it.
    const r = scoreCase(
      { intent: 'strategy.onboard', confidence: 0.8, entityRef: 'from_message' },
      evalCase({ expect: { intent: 'strategy.onboard', requestedOutcome: 'onboard' } }),
      0,
    );
    expect(r.actualIntent).toBe('strategy.onboard');
    expect(r.intentMatch).toBe(true); // intent recognized correctly
    expect(r.schemaValid).toBe(false); // ...but the object would NOT pass the strict gate
    expect(r.payloadScore).toBeNull(); // payload still not scored on a schema-invalid output
    expect(r.error?.type).toBe('schema');
  });

  it('treats null optional fields as absent (OpenAI nullable eval outputs pass the prod gate)', () => {
    const r = scoreCase(
      { intent: 'help', confidence: 0.9, strategyText: null, hypothesisText: null, entityRef: null, taskIdHint: null, requestedOutcome: null, rationale: null },
      evalCase({ expect: { intent: 'help' } }),
      0,
    );
    expect(r.schemaValid).toBe(true); // nulls stripped -> valid under the .optional() prod schema
    expect(r.intentMatch).toBe(true);
    expect(r.actualIntent).toBe('help');
    expect(r.error).toBeNull();
  });

  it('a null on an expected payload field counts as missing (not present)', () => {
    const r = scoreCase(
      { intent: 'strategy.onboard', confidence: 0.9, strategyText: null, requestedOutcome: 'onboard' },
      evalCase({ expect: { intent: 'strategy.onboard', hasStrategyText: true } }),
      0,
    );
    expect(r.schemaValid).toBe(true); // null stripped
    expect(r.intentMatch).toBe(true);
    expect(r.payloadScore).toBe(0); // strategyText absent -> hasStrategyText fails
  });

  it('a schema-invalid object with the WRONG intent is still an intent miss', () => {
    const r = scoreCase(
      { intent: 'out_of_scope', confidence: 0.8, entityRef: 'from_message' },
      evalCase({ expect: { intent: 'help' } }),
      0,
    );
    expect(r.intentMatch).toBe(false);
    expect(r.schemaValid).toBe(false);
  });

  it('leaves actualIntent null when the raw output has no usable intent field', () => {
    expect(scoreCase({ confidence: 0.9 }, evalCase({ expect: { intent: 'help' } }), 0).actualIntent).toBeNull();
    expect(scoreCase('not even an object', evalCase({ expect: { intent: 'help' } }), 0).actualIntent).toBeNull();
  });

  it('rejects a missing confidence as schema-invalid', () => {
    const r = scoreCase({ intent: 'help' }, evalCase({ expect: { intent: 'help' } }), 0);
    expect(r.schemaValid).toBe(false);
    expect(r.error?.type).toBe('schema');
  });

  it('rejects unknown keys (.strict) as schema-invalid', () => {
    const r = scoreCase({ intent: 'help', confidence: 0.9, bogus: 1 }, evalCase({ expect: { intent: 'help' } }), 0);
    expect(r.schemaValid).toBe(false);
  });
});

describe('scoreCase — payload checks (secondary signal)', () => {
  it('payloadScore is null when the case has no payload expectations', () => {
    const r = scoreCase({ intent: 'results.trading', confidence: 0.9 }, evalCase({ expect: { intent: 'results.trading' } }), 0);
    expect(r.payloadScore).toBeNull();
    expect(r.payloadChecks).toEqual([]);
  });

  it('scores requestedOutcome + hasStrategyText when both are expected and present', () => {
    const r = scoreCase(
      { intent: 'strategy.onboard', confidence: 0.9, requestedOutcome: 'onboard', strategyText: 'long when OI rises' },
      evalCase({ expect: { intent: 'strategy.onboard', requestedOutcome: 'onboard', hasStrategyText: true } }),
      0,
    );
    expect(r.payloadScore).toBe(1);
    expect(r.payloadChecks.map((c) => c.field).sort()).toEqual(['hasStrategyText', 'requestedOutcome']);
  });

  it('penalises a wrong requestedOutcome and an empty strategyText', () => {
    const r = scoreCase(
      { intent: 'strategy.onboard', confidence: 0.9, requestedOutcome: 'research', strategyText: '   ' },
      evalCase({ expect: { intent: 'strategy.onboard', requestedOutcome: 'onboard', hasStrategyText: true } }),
      0,
    );
    expect(r.payloadScore).toBe(0);
  });

  it('scores entityRef + hasHypothesisText for hypothesis cases', () => {
    const r = scoreCase(
      { intent: 'hypothesis.build', confidence: 0.9, entityRef: 'from_message_text', hypothesisText: 'funding precedes reversal' },
      evalCase({ expect: { intent: 'hypothesis.build', entityRef: 'from_message_text', hasHypothesisText: true } }),
      0,
    );
    expect(r.payloadScore).toBe(1);
  });

  it('gives partial payload credit (half the expected checks pass)', () => {
    const r = scoreCase(
      { intent: 'strategy.onboard', confidence: 0.9, requestedOutcome: 'onboard', strategyText: '' },
      evalCase({ expect: { intent: 'strategy.onboard', requestedOutcome: 'onboard', hasStrategyText: true } }),
      0,
    );
    expect(r.payloadScore).toBe(0.5);
  });
});

describe('scoreRun — dataset aggregate', () => {
  const cr = (intentMatch: boolean, payloadScore: number | null): CaseResult => ({
    id: 'x', lang: 'ru', expectedIntent: 'help', actualIntent: intentMatch ? 'help' : 'out_of_scope',
    intentMatch, schemaValid: true, payloadChecks: [], payloadScore, latencyMs: 1, error: null,
  });

  it('intentAccuracy = correct / total and score == intentAccuracy', () => {
    const s = scoreRun([cr(true, null), cr(true, null), cr(false, null), cr(false, null)], { threshold: 0.5 });
    expect(s.intentAccuracy).toBe(0.5);
    expect(s.score).toBe(0.5);
    expect(s.caseCount).toBe(4);
  });

  it('verdict PASS when intentAccuracy >= threshold, FAIL otherwise', () => {
    expect(scoreRun([cr(true, null), cr(false, null)], { threshold: 0.5 }).verdict).toBe('PASS');
    expect(scoreRun([cr(true, null), cr(false, null)], { threshold: 0.6 }).verdict).toBe('FAIL');
  });

  it('payloadAccuracy averages only cases that carried payload expectations', () => {
    const s = scoreRun([cr(true, 1), cr(true, 0), cr(true, null)], { threshold: 0.5 });
    expect(s.payloadAccuracy).toBe(0.5); // (1 + 0) / 2, the null case excluded
  });

  it('payloadAccuracy is null when no case had payload expectations', () => {
    const s = scoreRun([cr(true, null), cr(false, null)], { threshold: 0.5 });
    expect(s.payloadAccuracy).toBeNull();
  });

  it('counts schema-valid cases', () => {
    const invalid: CaseResult = { ...cr(false, null), schemaValid: false, actualIntent: null };
    const s = scoreRun([cr(true, null), invalid], { threshold: 0.5 });
    expect(s.schemaValidCount).toBe(1);
  });

  it('separates intent accuracy from schema validity (real eval split)', () => {
    // one fully-valid correct case + one schema-invalid case whose intent still matched
    const valid = scoreCase({ intent: 'help', confidence: 0.9 }, { id: 'a', lang: 'en', message: 'help', expect: { intent: 'help' } }, 0);
    const invalidButRight = scoreCase({ intent: 'help', confidence: 0.9, entityRef: 'from_message' }, { id: 'b', lang: 'en', message: 'help!', expect: { intent: 'help' } }, 0);
    const s = scoreRun([valid, invalidButRight], { threshold: 0.5 });
    expect(s.intentAccuracy).toBe(1); // both intents matched -> primary metric is 1.0
    expect(s.schemaValidRate).toBe(0.5); // only one passed the strict gate
    expect(s.verdict).toBe('PASS'); // verdict tracks intentAccuracy
  });

  it('uses DEFAULT_THRESHOLD when none is supplied', () => {
    const s = scoreRun([cr(true, null)]);
    expect(s.threshold).toBe(DEFAULT_THRESHOLD);
  });
});
