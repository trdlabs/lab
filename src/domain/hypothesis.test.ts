// src/domain/hypothesis.test.ts
import { describe, it, expect } from 'vitest';
import {
  HypothesisProposalDraftSchema, ResearcherOutputSchema, RuleActionSchema,
  hypothesisFingerprint, HYPOTHESIS_PROPOSAL_CONTRACT_VERSION,
} from './hypothesis.ts';

const draft = {
  thesis: 'Skipping entries while OI is falling improves win rate',
  targetBehavior: 'Filter entries by open interest trend',
  ruleAction: { appliesTo: 'long' as const, rules: [{ when: 'oi falling', action: 'skip_entry' as const, params: { bars: 3 } }] },
  requiredFeatures: ['oi'],
  validationPlan: 'Backtest baseline vs variant over 90 days',
  expectedEffect: { metric: 'win_rate', direction: 'increase' as const },
  invalidationCriteria: ['No win_rate improvement vs baseline'],
  confidence: 0.6,
};

describe('hypothesis schemas', () => {
  it('accepts a well-formed draft', () => {
    expect(HypothesisProposalDraftSchema.safeParse(draft).success).toBe(true);
  });

  it('rejects an empty invalidationCriteria', () => {
    const bad = { ...draft, invalidationCriteria: [] };
    expect(HypothesisProposalDraftSchema.safeParse(bad).success).toBe(false);
  });

  it('defaults rule params to an empty object', () => {
    const parsed = RuleActionSchema.parse({ appliesTo: 'short', rules: [{ when: 'x', action: 'no_op' }] });
    expect(parsed.rules[0]!.params).toEqual({});
  });

  it('parses a researcher output envelope', () => {
    const ok = ResearcherOutputSchema.safeParse({ hypotheses: [draft], researchSummary: 's' });
    expect(ok.success).toBe(true);
  });

  it('exposes the contract version', () => {
    expect(HYPOTHESIS_PROPOSAL_CONTRACT_VERSION).toBe('hypothesis-proposal-v1');
  });
});

describe('hypothesisFingerprint', () => {
  it('is stable regardless of ruleAction key order', () => {
    const a = hypothesisFingerprint(draft.thesis, { appliesTo: 'long', rules: [{ when: 'oi falling', action: 'skip_entry', params: { bars: 3, z: 1 } }] });
    const b = hypothesisFingerprint(draft.thesis, { appliesTo: 'long', rules: [{ when: 'oi falling', action: 'skip_entry', params: { z: 1, bars: 3 } }] });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changes when the thesis changes', () => {
    const a = hypothesisFingerprint('thesis one', draft.ruleAction);
    const b = hypothesisFingerprint('thesis two', draft.ruleAction);
    expect(a).not.toBe(b);
  });

  it('is insensitive to CRLF and surrounding whitespace in the thesis', () => {
    const a = hypothesisFingerprint('a\r\nb', draft.ruleAction);
    const b = hypothesisFingerprint('  a\nb  ', draft.ruleAction);
    expect(a).toBe(b);
  });
});
