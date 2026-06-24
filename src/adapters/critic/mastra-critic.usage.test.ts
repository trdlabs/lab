import { describe, it, expect } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import { MastraCritic } from './mastra-critic.ts';
import type { CriticInput } from '../../domain/critic.ts';
import type { HypothesisProposalDraft } from '../../domain/hypothesis.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';

const draft: HypothesisProposalDraft = {
  thesis: 'Skip entries while OI is falling', targetBehavior: 'Filter entries',
  ruleAction: { appliesTo: 'long', rules: [{ when: 'oi falling', action: 'skip_entry', params: {} }] },
  requiredFeatures: ['oi'], validationPlan: 'backtest', expectedEffect: { metric: 'win_rate', direction: 'increase' },
  invalidationCriteria: ['no improvement'], confidence: 0.5,
};

const validInput: CriticInput = {
  proposal: draft,
  profile: { id: 'p1', coreIdea: 'x', direction: 'long', requiredMarketFeatures: ['oi'] } as unknown as StrategyProfile,
};

/** Valid output satisfying CriticOutputSchema. */
const validObject = {
  verdict: 'ok',
  concerns: [],
  summary: 'Looks good',
};

function fakeAgent(inputTokens: number, outputTokens: number, totalTokens: number): Agent {
  return { generate: async () => ({ object: validObject, usage: { inputTokens, outputTokens, totalTokens } }) } as unknown as Agent;
}

describe('MastraCritic onUsage', () => {
  it('reports result.usage as AgentCallUsage object when present', async () => {
    let recorded: { modelId: string; inputTokens: number; outputTokens: number; totalTokens: number } | null = null;
    const adapter = new MastraCritic(fakeAgent(100, 23, 123), 'test-critic');
    await adapter.review(validInput, { onUsage: (u) => { recorded = u; } });
    expect(recorded).toEqual({ modelId: 'test-critic', inputTokens: 100, outputTokens: 23, totalTokens: 123 });
  });

  it('coerces missing usage to 0 for all fields', async () => {
    let recorded: { modelId: string; inputTokens: number; outputTokens: number; totalTokens: number } | null = null;
    const agent = { generate: async () => ({ object: validObject }) } as unknown as Agent;
    const adapter = new MastraCritic(agent, 'test-critic');
    await adapter.review(validInput, { onUsage: (u) => { recorded = u; } });
    expect(recorded).toEqual({ modelId: 'test-critic', inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });
});
