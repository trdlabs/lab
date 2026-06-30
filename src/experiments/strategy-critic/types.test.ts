import { describe, it, expect } from 'vitest';
import { JudgeVerdictSchema, type JudgeVerdict } from './types.ts';
import type { CandidateResult, ModelAggregate, ScoreResult as CriticScoreResult } from './types.ts';
import type { ScoreResult as AnalystScoreResult } from '../strategy-analyst/types.ts';
import { CLEAN_LONG_OI_BASE } from '../strategy-analyst/__fixtures__/profiles.ts';

const VALID: JudgeVerdict = {
  dimensions: [{ name: 'strengthens-weaknesses', score: 0.8, rationale: 'addressed crowding' }],
  overallScore: 0.75,
  hallucinations: [],
  missing: ['no explicit invalidation'],
  notes: 'solid',
};

describe('CandidateResult round-trip fields', () => {
  it('carries profile + profileScore (null when round-trip is off)', () => {
    const detScore: CriticScoreResult = {
      gates: { schemaValid: true, directionPreserved: true, noRunnerOverreach: true, nonTrivialChange: true },
      checks: [], score: 0.8, threshold: 0.6, verdict: 'PASS',
    };
    const off: CandidateResult = {
      label: 'single:m', mode: 'single', criticModel: 'm', refinerModel: null, caseId: 'pump-short',
      latencyMs: 100, verdict: 'PASS', score: detScore, rawOutput: null, error: null, judge: null,
      profile: null, profileScore: null,
    };
    expect(off.profile).toBeNull();
    expect(off.profileScore).toBeNull();

    const profileScore: AnalystScoreResult = {
      gates: { schemaValid: true, directionLong: true }, checks: [], score: 0.9, threshold: 0.8, verdict: 'PASS',
    };
    const on: CandidateResult = { ...off, profile: CLEAN_LONG_OI_BASE, profileScore };
    expect(on.profile?.direction).toBe('long');
    expect(on.profileScore?.score).toBe(0.9);
  });

  it('ModelAggregate exposes an optional profile Stats', () => {
    const agg: Pick<ModelAggregate, 'profile'> = { profile: { mean: 0.9, median: 0.9, std: 0, min: 0.9, max: 0.9 } };
    expect(agg.profile?.mean).toBe(0.9);
  });
});

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
