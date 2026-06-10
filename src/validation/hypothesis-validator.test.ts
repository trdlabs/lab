// src/validation/hypothesis-validator.test.ts
import { describe, it, expect } from 'vitest';
import { validateHypothesis } from './hypothesis-validator.ts';
import { LAB_FEATURE_CATALOG } from '../domain/hypothesis-rules.ts';
import type { HypothesisProposalDraft } from '../domain/hypothesis.ts';

const allowed = new Set<string>([...LAB_FEATURE_CATALOG]);

function baseDraft(): HypothesisProposalDraft {
  return {
    thesis: 'Skip entries while OI is falling',
    targetBehavior: 'Filter entries by OI trend',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'oi falling', action: 'skip_entry', params: { bars: 3 } }] },
    requiredFeatures: ['Open Interest'],
    validationPlan: 'Backtest baseline vs variant',
    expectedEffect: { metric: 'win_rate', direction: 'increase' },
    invalidationCriteria: ['No improvement vs baseline'],
    confidence: 0.6,
  };
}

describe('validateHypothesis', () => {
  it('validates a clean draft and normalizes features', () => {
    const r = validateHypothesis(baseDraft(), { allowedFeatures: allowed });
    expect(r.status).toBe('validated');
    expect(r.issues).toEqual([]);
    expect(r.normalizedFeatures).toEqual(['oi']);
  });

  it('rejects empty invalidationCriteria', () => {
    const r = validateHypothesis({ ...baseDraft(), invalidationCriteria: [] }, { allowedFeatures: allowed });
    expect(r.status).toBe('rejected');
    expect(r.issues.map((i) => i.code)).toContain('missing_falsifiability');
  });

  it('rejects an unavailable feature', () => {
    const r = validateHypothesis({ ...baseDraft(), requiredFeatures: ['some_unknown_feature'] }, { allowedFeatures: allowed });
    expect(r.issues.map((i) => i.code)).toContain('unavailable_feature');
  });

  it('rejects disallowed param key semantics', () => {
    const d = baseDraft();
    d.ruleAction.rules[0]!.params = { leverage: 5 };
    const r = validateHypothesis(d, { allowedFeatures: allowed });
    expect(r.issues.map((i) => i.code)).toContain('action_param_violation');
  });

  it('rejects disallowed param value semantics', () => {
    const d = baseDraft();
    d.ruleAction.rules[0]!.params = { note: 'place order on exchange' };
    const r = validateHypothesis(d, { allowedFeatures: allowed });
    expect(r.issues.map((i) => i.code)).toContain('action_param_violation');
  });

  it('rejects live-execution intent in text', () => {
    const r = validateHypothesis({ ...baseDraft(), thesis: 'Place order on the exchange when OI falls' }, { allowedFeatures: allowed });
    expect(r.issues.map((i) => i.code)).toContain('live_intent');
  });

  it('rejects lookahead markers', () => {
    const r = validateHypothesis({ ...baseDraft(), targetBehavior: 'Use next candle close known in advance' }, { allowedFeatures: allowed });
    expect(r.issues.map((i) => i.code)).toContain('lookahead_marker');
  });

  it('rejects runner-owned authority claims', () => {
    const r = validateHypothesis({ ...baseDraft(), thesis: 'Set leverage to 5x and own execution' }, { allowedFeatures: allowed });
    expect(r.issues.map((i) => i.code)).toContain('authority_violation');
  });

  it('rejects a disallowed action', () => {
    const d = baseDraft();
    (d.ruleAction.rules[0] as { action: string }).action = 'send_market_order';
    const r = validateHypothesis(d, { allowedFeatures: allowed });
    expect(r.issues.map((i) => i.code)).toContain('disallowed_action');
  });

  it('produces deterministically sorted issues (by path)', () => {
    const d = baseDraft();
    d.invalidationCriteria = [];           // -> missing_falsifiability at path 'invalidationCriteria'
    d.requiredFeatures = ['nope'];         // -> unavailable_feature at path 'requiredFeatures.0'
    const r = validateHypothesis(d, { allowedFeatures: allowed });
    const paths = r.issues.map((i) => i.path);
    // locale-independent ascending order: 'invalidationCriteria' < 'requiredFeatures.0'
    expect(paths).toEqual([...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['missing_falsifiability', 'unavailable_feature']));
  });
});
