import { describe, it, expect } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import { MastraBuilder } from './mastra-builder.ts';
import type { BuilderInput } from '../../ports/builder.port.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';

function hypothesis(): HypothesisProposal {
  const now = '2026-01-01T00:00:00Z';
  return {
    id: 'h1', strategyProfileId: 'p1', thesis: 'Skip entries when OI trend persists for 3+ bars',
    targetBehavior: 'filter entries',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'oi trend persists for 2 bars', action: 'skip_entry', params: { bars: 2 } }] },
    requiredFeatures: ['oi', 'funding'], validationPlan: 'backtest 90d',
    expectedEffect: { metric: 'win_rate', direction: 'increase' }, invalidationCriteria: ['no improvement'],
    confidence: 0.5, status: 'validated', fingerprint: 'sha256:abc', proposal: {} as never,
    issues: [], contractVersion: 'hypothesis-proposal-v1', createdAt: now, updatedAt: now,
  };
}

function profile(): StrategyProfile {
  return { id: 'p1', requiredMarketFeatures: ['oi', 'funding'], direction: 'long' } as unknown as StrategyProfile;
}

const validInput: BuilderInput = { hypothesis: hypothesis(), profile: profile(), sdkDoc: 'SDK_DOC' };

/** Valid LLM output that satisfies LlmBuilderOutputSchema and maps cleanly through domain. */
const validObject = {
  manifest: {
    moduleId: 'overlay-h1',
    moduleKind: 'hypothesis_overlay',
    appliesTo: 'long',
    entry: 'index.ts',
    exports: ['overlay'],
    capabilities: ['oi'],
    sdkContractVersion: '1',
  },
  files: [{ name: 'index.ts', content: 'export const overlay = {};' }],
  notes: null,
};

function fakeAgent(inputTokens: number, outputTokens: number, totalTokens: number): Agent {
  return { generate: async () => ({ object: validObject, usage: { inputTokens, outputTokens, totalTokens } }) } as unknown as Agent;
}

describe('MastraBuilder onUsage', () => {
  it('reports result.usage as AgentCallUsage object when present', async () => {
    let recorded: { modelId: string; inputTokens: number; outputTokens: number; totalTokens: number } | null = null;
    const adapter = new MastraBuilder(fakeAgent(100, 23, 123), 'test-builder');
    await adapter.build(validInput, { onUsage: (u) => { recorded = u; } });
    expect(recorded).toEqual({ modelId: 'test-builder', inputTokens: 100, outputTokens: 23, totalTokens: 123 });
  });

  it('coerces missing usage to 0 for all fields', async () => {
    let recorded: { modelId: string; inputTokens: number; outputTokens: number; totalTokens: number } | null = null;
    const agent = { generate: async () => ({ object: validObject }) } as unknown as Agent;
    const adapter = new MastraBuilder(agent, 'test-builder');
    await adapter.build(validInput, { onUsage: (u) => { recorded = u; } });
    expect(recorded).toEqual({ modelId: 'test-builder', inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });
});
