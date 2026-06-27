import { describe, it, expect } from 'vitest';
import { JudgeVerdictSchema, type JudgeVerdict } from './types.ts';

const VALID: JudgeVerdict = {
  dimensions: [{ name: 'strengthens-weaknesses', score: 0.8, rationale: 'addressed crowding' }],
  overallScore: 0.75,
  hallucinations: [],
  missing: ['no explicit invalidation'],
  notes: 'solid',
};

describe('JudgeVerdictSchema', () => {
  it('round-trips a valid verdict', () => {
    expect(JudgeVerdictSchema.parse(VALID)).toEqual(VALID);
  });
  it('rejects an out-of-range overallScore', () => {
    expect(JudgeVerdictSchema.safeParse({ ...VALID, overallScore: 1.5 }).success).toBe(false);
  });
  it('rejects a missing required field', () => {
    const { notes, ...withoutNotes } = VALID;
    expect(JudgeVerdictSchema.safeParse(withoutNotes).success).toBe(false);
  });
});
