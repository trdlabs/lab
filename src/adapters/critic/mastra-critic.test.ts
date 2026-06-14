import { describe, it, expect } from 'vitest';
import { MastraCritic } from './mastra-critic.ts';
import { CriticOutputSchema } from '../../domain/critic.ts';
import type { HypothesisProposalDraft } from '../../domain/hypothesis.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import { resolveLanguageModel } from '../llm/model-provider.ts';
import { createCriticAgent } from '../../mastra/agents/critic.agent.ts';

const run = process.env.RUN_LLM_TESTS === 'true' && !!process.env.ANTHROPIC_API_KEY;

describe('MastraCritic (construction)', () => {
  it('stores the label and builds an agent from an injected model', () => {
    const { model, label } = resolveLanguageModel({ MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'dummy' }, 'anthropic/claude-sonnet-4-6');
    const c = new MastraCritic(createCriticAgent(model), label);
    expect(c.adapter).toBe('mastra');
    expect(c.model).toBe('anthropic/claude-sonnet-4-6');
  });
});

(run ? describe : describe.skip)('MastraCritic (live)', () => {
  it('returns schema-valid advisory output', async () => {
    const { model, label } = resolveLanguageModel(
      { MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
      'anthropic/claude-sonnet-4-6',
    );
    const draft: HypothesisProposalDraft = {
      thesis: 'Skip entries while OI is falling', targetBehavior: 'Filter entries',
      ruleAction: { appliesTo: 'long', rules: [{ when: 'oi falling', action: 'skip_entry', params: {} }] },
      requiredFeatures: ['oi'], validationPlan: 'backtest', expectedEffect: { metric: 'win_rate', direction: 'increase' },
      invalidationCriteria: ['no improvement'], confidence: 0.5,
    };
    const profile = { id: 'p1', coreIdea: 'x', direction: 'long', requiredMarketFeatures: ['oi'] } as unknown as StrategyProfile;
    const out = await new MastraCritic(createCriticAgent(model), label).review({ proposal: draft, profile });
    expect(CriticOutputSchema.safeParse(out).success).toBe(true);
  }, 60_000);
});
