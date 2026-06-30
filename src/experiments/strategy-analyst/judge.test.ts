// src/experiments/strategy-analyst/judge.test.ts
import { describe, it, expect } from 'vitest';
import { runJudge, buildJudgePrompt } from './judge.ts';
import { JudgeVerdictSchema, type JudgeVerdict } from './types.ts';
import { CLEAN_LONG_OI_BASE } from './__fixtures__/profiles.ts';

// Minimal fake of the @mastra/core Agent surface used by runJudge.
function fakeAgent(verdict: JudgeVerdict) {
  return {
    async generate(_prompt: string, _opts: unknown) {
      return { object: verdict };
    },
  };
}

const verdict: JudgeVerdict = {
  dimensions: [{ name: 'direction', score: 1, rationale: 'long' }],
  overallScore: 0.85, hallucinations: [], missingFromProfile: [], notes: 'good',
};

describe('buildJudgePrompt', () => {
  it('includes the rubric, the research notes, and the candidate profile JSON', () => {
    const prompt = buildJudgePrompt({ profile: CLEAN_LONG_OI_BASE, rubricText: 'RUBRIC-MARK', notesText: 'NOTES-MARK' });
    expect(prompt).toContain('RUBRIC-MARK');
    expect(prompt).toContain('NOTES-MARK');
    expect(prompt).toContain('"direction": "long"');
  });
});

describe('runJudge', () => {
  it('returns a schema-valid JudgeVerdict from the agent', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await runJudge(fakeAgent(verdict) as any, { profile: CLEAN_LONG_OI_BASE, rubricText: 'r', notesText: 'n' });
    expect(JudgeVerdictSchema.safeParse(out).success).toBe(true);
    expect(out.overallScore).toBe(0.85);
  });
});
