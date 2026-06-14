// src/mastra/compose-mastra.test.ts
import { describe, it, expect } from 'vitest';
import { composeMastra, type MastraCompositionEnv } from './compose-mastra.ts';

const base: MastraCompositionEnv = {
  MODEL_PROVIDER: 'anthropic',
  ANTHROPIC_API_KEY: 'dummy',
  STRATEGY_ANALYST_ADAPTER: 'fake', STRATEGY_ANALYST_MODEL: 'anthropic/claude-sonnet-4-6',
  RESEARCHER_ADAPTER: 'fake', RESEARCHER_MODEL: 'anthropic/claude-sonnet-4-6',
  CRITIC_ADAPTER: 'fake', CRITIC_MODEL: 'anthropic/claude-sonnet-4-6', ENABLE_CRITIC_AGENT: false,
  INTENT_CLASSIFIER_ADAPTER: 'fake', INTENT_CLASSIFIER_MODEL: 'anthropic/claude-haiku-4-5-20251001',
  BUILDER_ADAPTER: 'fake', BUILDER_MODEL: 'anthropic/claude-sonnet-4-6',
};

describe('composeMastra', () => {
  it('registers no agents when every role is fake, but still returns a Mastra instance', () => {
    const rt = composeMastra(base);
    expect(rt.mastra).toBeDefined();
    expect(rt.agents.analyst).toBeUndefined();
    expect(rt.agents.researcher).toBeUndefined();
    expect(rt.agents.critic).toBeUndefined();
    expect(rt.agents.builder).toBeUndefined();
    expect(rt.agents.intentClassifier).toBeUndefined();
  });

  it('registers a mastra-mode role with its label and leaves fake roles undefined', () => {
    const rt = composeMastra({ ...base, RESEARCHER_ADAPTER: 'mastra' });
    expect(rt.agents.researcher).toBeDefined();
    expect(rt.agents.researcher!.label).toBe('anthropic/claude-sonnet-4-6');
    expect(rt.agents.researcher!.agent.name).toBe('Researcher');
    expect(rt.agents.analyst).toBeUndefined();
  });

  it('gates critic on ENABLE_CRITIC_AGENT even when CRITIC_ADAPTER=mastra', () => {
    const off = composeMastra({ ...base, CRITIC_ADAPTER: 'mastra', ENABLE_CRITIC_AGENT: false });
    expect(off.agents.critic).toBeUndefined();
    const on = composeMastra({ ...base, CRITIC_ADAPTER: 'mastra', ENABLE_CRITIC_AGENT: true });
    expect(on.agents.critic).toBeDefined();
    expect(on.agents.critic!.agent.name).toBe('Critic');
  });
});
