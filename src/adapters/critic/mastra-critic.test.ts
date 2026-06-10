import { describe, it, expect } from 'vitest';
import { MastraCritic } from './mastra-critic.ts';
import { CriticOutputSchema } from '../../domain/critic.ts';
import type { HypothesisProposalDraft } from '../../domain/hypothesis.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';

const run = process.env.RUN_LLM_TESTS === 'true' && !!process.env.ANTHROPIC_API_KEY;

describe('MastraCritic (construction)', () => {
  it('rejects non-Anthropic models', () => {
    expect(() => new MastraCritic('openai/gpt-4o')).toThrow();
  });
  it('exposes adapter identity', () => {
    const c = new MastraCritic('anthropic/claude-sonnet-4-6');
    expect(c.adapter).toBe('mastra');
    expect(c.model).toBe('anthropic/claude-sonnet-4-6');
  });
});

(run ? describe : describe.skip)('MastraCritic (live)', () => {
  it('returns schema-valid advisory output', async () => {
    const draft: HypothesisProposalDraft = {
      thesis: 'Skip entries while OI is falling', targetBehavior: 'Filter entries',
      ruleAction: { appliesTo: 'long', rules: [{ when: 'oi falling', action: 'skip_entry', params: {} }] },
      requiredFeatures: ['oi'], validationPlan: 'backtest', expectedEffect: { metric: 'win_rate', direction: 'increase' },
      invalidationCriteria: ['no improvement'], confidence: 0.5,
    };
    const profile = { id: 'p1', coreIdea: 'x', direction: 'long', requiredMarketFeatures: ['oi'] } as unknown as StrategyProfile;
    const out = await new MastraCritic('anthropic/claude-sonnet-4-6').review({ proposal: draft, profile });
    expect(CriticOutputSchema.safeParse(out).success).toBe(true);
  }, 60_000);
});
