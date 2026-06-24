// src/mastra/compose-mastra.test.ts
import { describe, it, expect } from 'vitest';
import { composeMastra, phoenixArizeConfig, phoenixObservability, type MastraCompositionEnv } from './compose-mastra.ts';
import { ArizeExporter } from '@mastra/arize';

const base: MastraCompositionEnv = {
  MODEL_PROVIDER: 'anthropic',
  ANTHROPIC_API_KEY: 'dummy',
  STRATEGY_ANALYST_ADAPTER: 'fake', STRATEGY_ANALYST_MODEL: 'anthropic/claude-sonnet-4-6',
  RESEARCHER_ADAPTER: 'fake', RESEARCHER_MODEL: 'anthropic/claude-sonnet-4-6',
  CRITIC_ADAPTER: 'fake', CRITIC_MODEL: 'anthropic/claude-sonnet-4-6', ENABLE_CRITIC_AGENT: false,
  TURN_INTERPRETER_ADAPTER: 'fake', TURN_INTERPRETER_MODEL: 'openrouter/google/gemini-3.1-flash-lite',
  BUILDER_ADAPTER: 'fake', BUILDER_MODEL: 'anthropic/claude-sonnet-4-6',
  PHOENIX_ENABLED: false,
  PHOENIX_COLLECTOR_ENDPOINT: 'http://localhost:6006/v1/traces',
  PHOENIX_PROJECT_NAME: 'trading-lab',
};

describe('composeMastra', () => {
  it('registers no agents when every role is fake, but still returns a Mastra instance', () => {
    const rt = composeMastra(base);
    expect(rt.mastra).toBeDefined();
    expect(rt.agents.analyst).toBeUndefined();
    expect(rt.agents.researcher).toBeUndefined();
    expect(rt.agents.critic).toBeUndefined();
    expect(rt.agents.builder).toBeUndefined();
    expect(rt.agents.turnInterpreter).toBeUndefined();
    expect('intentClassifier' in rt.agents).toBe(false); // the dormant agent is gone
  });

  it('builds the turn interpreter from TURN_INTERPRETER_MODEL when adapter=mastra', () => {
    const env = { ...base, TURN_INTERPRETER_ADAPTER: 'mastra' as const,
      TURN_INTERPRETER_MODEL: 'anthropic/claude-haiku-4-5-20251001' } as const;
    const rt = composeMastra(env);
    expect(rt.agents.turnInterpreter?.label).toContain('claude-haiku');
    expect('intentClassifier' in rt.agents).toBe(false); // the dormant agent is gone
  });

  it('skips the turn interpreter when TURN_INTERPRETER_ADAPTER is fake', () => {
    const env = { ...base, TURN_INTERPRETER_ADAPTER: 'fake' as const };
    expect(composeMastra(env).agents.turnInterpreter).toBeUndefined();
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

describe('phoenixArizeConfig', () => {
  it('returns undefined when PHOENIX_ENABLED is false', () => {
    expect(phoenixArizeConfig(base)).toBeUndefined();
  });

  it('builds one ArizeExporter under the project serviceName when enabled', () => {
    const cfg = phoenixArizeConfig({
      ...base,
      PHOENIX_ENABLED: true,
      PHOENIX_PROJECT_NAME: 'trading-lab',
      PHOENIX_COLLECTOR_ENDPOINT: 'http://phoenix:6006/v1/traces',
    });
    expect(cfg).toBeDefined();
    expect(cfg!.serviceName).toBe('trading-lab');
    expect(cfg!.exporters).toHaveLength(1);
    expect(cfg!.exporters[0]).toBeInstanceOf(ArizeExporter);
  });

  it('composeMastra still returns a Mastra instance with Phoenix enabled', () => {
    const rt = composeMastra({ ...base, PHOENIX_ENABLED: true });
    expect(rt.mastra).toBeDefined();
  });
});

describe('phoenixObservability', () => {
  it('returns undefined when PHOENIX_ENABLED is false', () => {
    expect(phoenixObservability(base)).toBeUndefined();
  });

  it('returns a real Observability instance with getDefaultInstance when enabled', () => {
    const obs = phoenixObservability({ ...base, PHOENIX_ENABLED: true });
    expect(obs).toBeDefined();
    // @mastra/core@1.41 checks `typeof config.observability.getDefaultInstance === 'function'`
    // before attaching. This assertion proves we return a real Observability, not a bare
    // config object or a NoOp stub.
    expect(typeof obs!.getDefaultInstance).toBe('function');
  });
});
