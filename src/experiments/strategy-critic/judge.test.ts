import { describe, it, expect } from 'vitest';
import { buildJudgePrompt } from './judge.ts';
import { GOOD_PUMP_SHORT_REFINEMENT } from './__fixtures__/refinements.ts';
import { CLEAN_LONG_OI_BASE } from '../strategy-analyst/__fixtures__/profiles.ts';

describe('buildJudgePrompt', () => {
  it('embeds the original text and the candidate refinement JSON', () => {
    const prompt = buildJudgePrompt({ originalText: 'шорт после пампа от 10% за 20 минут', refinement: GOOD_PUMP_SHORT_REFINEMENT });
    expect(prompt).toContain('шорт после пампа от 10% за 20 минут');
    expect(prompt).toContain(GOOD_PUMP_SHORT_REFINEMENT.improvedStrategyText);
    expect(prompt).toContain('Return the structured judge verdict.');
  });
});

describe('buildJudgePrompt — resulting profile block', () => {
  it('appends the profile block when a profile is present', () => {
    const prompt = buildJudgePrompt({ originalText: 'orig', refinement: GOOD_PUMP_SHORT_REFINEMENT, profile: CLEAN_LONG_OI_BASE });
    expect(prompt).toContain('--- RESULTING ANALYST PROFILE (JSON) ---');
    expect(prompt).toContain(JSON.stringify(CLEAN_LONG_OI_BASE, null, 2));
    expect(prompt).toContain('Return the structured judge verdict.');
  });

  it('omits the profile block when no profile is provided', () => {
    const prompt = buildJudgePrompt({ originalText: 'orig', refinement: GOOD_PUMP_SHORT_REFINEMENT });
    expect(prompt).not.toContain('RESULTING ANALYST PROFILE');
  });
});
