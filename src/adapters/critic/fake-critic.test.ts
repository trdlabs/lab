import { describe, it, expect } from 'vitest';
import { FakeCritic } from './fake-critic.ts';
import { CriticOutputSchema } from '../../domain/critic.ts';
import type { HypothesisProposalDraft } from '../../domain/hypothesis.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';

const draft: HypothesisProposalDraft = {
  thesis: 'Skip entries while OI is falling', targetBehavior: 'Filter entries',
  ruleAction: { appliesTo: 'long', rules: [{ when: 'oi falling', action: 'skip_entry', params: {} }] },
  requiredFeatures: ['oi'], validationPlan: 'backtest', expectedEffect: { metric: 'win_rate', direction: 'increase' },
  invalidationCriteria: ['no improvement'], confidence: 0.5,
};
const profile = { id: 'p1', coreIdea: 'x', direction: 'long' } as unknown as StrategyProfile;

describe('FakeCritic', () => {
  it('reports fake adapter identity', () => {
    const c = new FakeCritic();
    expect(c.adapter).toBe('fake');
    expect(c.model).toBe('fake');
  });

  it('returns schema-valid advisory output', async () => {
    const out = await new FakeCritic().review({ proposal: draft, profile });
    expect(CriticOutputSchema.safeParse(out).success).toBe(true);
    expect(out.verdict).toBe('ok');
  });
});
