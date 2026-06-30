import { describe, it, expect } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import { MastraResearcher } from './mastra-researcher.ts';
import type { ResearcherInput } from '../../ports/researcher.port.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';

const validInput: ResearcherInput = {
  profile: {
    coreIdea: 'idea',
    direction: 'long',
    requiredMarketFeatures: [],
    profile: {
      summary: 'Enter after a >=10% dump over 20 minutes when OI recovers and long liquidations confirm the bounce.',
      entryConditions: ['Dump >=10% over 20m', 'OI recovery within 3 candles'],
      exitConditions: ['TP1 +3.5%', 'TP2 +5%', 'SL -12%', 'time exit 180m'],
      parameters: [{ name: 'dump.minDropPct', value: 10, unit: '%', description: 'Minimum dump', tunable: true }],
      positionManagementSummary: 'Up to two DCA adds, then move stop to breakeven after TP1.',
      riskManagementSummary: 'Runner owns leverage and execution; strategy controls overlays only.',
      unknowns: ['exact venue'],
      evidence: ['source quote'],
    },
  } as unknown as StrategyProfile,
  marketContext: { symbol: 'BTCUSDT', ts: '2026-01-01T00:00:00Z', features: {} },
  marketRegime: 'ranging',
  similarHypotheses: [],
  maxHypotheses: 2,
  focus: 'loss_reduction',
};

/** Valid LLM output satisfying LlmResearcherOutputSchema. */
const validObject = {
  hypotheses: [
    {
      thesis: 'Test thesis',
      targetBehavior: 'filter entries',
      ruleAction: { appliesTo: 'long', rules: [{ when: 'cond', action: 'skip_entry', params: {}, rationale: 'test rationale' }] },
      requiredFeatures: [],
      validationPlan: 'backtest',
      expectedEffect: { metric: 'win_rate', direction: 'increase', magnitude: null },
      invalidationCriteria: ['no improvement'],
      confidence: 0.5,
    },
  ],
  researchSummary: 'summary',
};

function fakeAgent(inputTokens: number, outputTokens: number, totalTokens: number): Agent {
  return { generate: async () => ({ object: validObject, usage: { inputTokens, outputTokens, totalTokens } }) } as unknown as Agent;
}

describe('MastraResearcher onUsage', () => {
  it('reports result.usage as AgentCallUsage object when present', async () => {
    let recorded: { modelId: string; inputTokens: number; outputTokens: number; totalTokens: number } | null = null;
    const adapter = new MastraResearcher(fakeAgent(100, 23, 123), 'test-researcher');
    await adapter.propose(validInput, { onUsage: (u) => { recorded = u; } });
    expect(recorded).toEqual({ modelId: 'test-researcher', inputTokens: 100, outputTokens: 23, totalTokens: 123 });
  });

  it('coerces missing usage to 0 for all fields', async () => {
    let recorded: { modelId: string; inputTokens: number; outputTokens: number; totalTokens: number } | null = null;
    const agent = { generate: async () => ({ object: validObject }) } as unknown as Agent;
    const adapter = new MastraResearcher(agent, 'test-researcher');
    await adapter.propose(validInput, { onUsage: (u) => { recorded = u; } });
    expect(recorded).toEqual({ modelId: 'test-researcher', inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });
});

describe('MastraResearcher tolerates omitted nullish LLM fields', () => {
  // Regression: a real gpt-5.5 run OMITTED the `rationale` key on a rule (instead of sending null),
  // which the previous `.nullable()` schema rejected ("rationale: Required") → hard-failed the cycle.
  it('accepts a rule missing rationale + an effect missing magnitude, dropping them in the domain output', async () => {
    const objectMissingNullables = {
      hypotheses: [{
        thesis: 'T', targetBehavior: 'b',
        ruleAction: { appliesTo: 'long', rules: [{ when: 'c', action: 'skip_entry', params: {} }] }, // no rationale key
        requiredFeatures: [], validationPlan: 'p',
        expectedEffect: { metric: 'win_rate', direction: 'increase' }, // no magnitude key
        invalidationCriteria: ['none'], confidence: 0.5,
      }],
      researchSummary: 's',
    };
    const agent = { generate: async () => ({ object: objectMissingNullables }) } as unknown as Agent;
    const adapter = new MastraResearcher(agent, 'test');
    const out = await adapter.propose(validInput);
    expect(out.hypotheses).toHaveLength(1);
    const rule = out.hypotheses[0]!.ruleAction.rules[0]!;
    expect('rationale' in rule).toBe(false);
    expect(out.hypotheses[0]!.expectedEffect.magnitude).toBeUndefined();
  });
});
