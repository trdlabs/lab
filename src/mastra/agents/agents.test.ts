// src/mastra/agents/agents.test.ts
import { describe, it, expect } from 'vitest';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createStrategyAnalystAgent, STRATEGY_ANALYST_AGENT_ID } from './strategy-analyst.agent.ts';
import { createResearcherAgent, RESEARCHER_AGENT_ID } from './researcher.agent.ts';
import { createCriticAgent, CRITIC_AGENT_ID } from './critic.agent.ts';
import { createBuilderAgent, BUILDER_AGENT_ID } from './builder.agent.ts';
import { createIntentClassifierAgent, INTENT_CLASSIFIER_AGENT_ID } from './intent-classifier.agent.ts';

const model = createAnthropic({ apiKey: 'dummy' })('claude-sonnet-4-6');

describe('mastra agent factories', () => {
  it('build agents with the expected id and name', () => {
    const cases = [
      [createStrategyAnalystAgent(model), STRATEGY_ANALYST_AGENT_ID, 'Strategy Analyst'],
      [createResearcherAgent(model), RESEARCHER_AGENT_ID, 'Researcher'],
      [createCriticAgent(model), CRITIC_AGENT_ID, 'Critic'],
      [createBuilderAgent(model), BUILDER_AGENT_ID, 'Builder'],
      [createIntentClassifierAgent(model), INTENT_CLASSIFIER_AGENT_ID, 'Intent Classifier'],
    ] as const;
    expect(cases).toHaveLength(5);
    for (const [agent, id, name] of cases) {
      expect(agent.id).toBe(id);
      expect(agent.name).toBe(name);
    }
  });
});
