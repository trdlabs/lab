import { Mastra } from '@mastra/core';
import type { Agent } from '@mastra/core/agent';
import { resolveLanguageModel } from '../adapters/llm/model-provider.ts';
import type { ModelProviderEnv, ProviderModel } from '../adapters/llm/model-provider.ts';
import { createStrategyAnalystAgent, STRATEGY_ANALYST_AGENT_ID } from './agents/strategy-analyst.agent.ts';
import { createResearcherAgent, RESEARCHER_AGENT_ID } from './agents/researcher.agent.ts';
import { createCriticAgent, CRITIC_AGENT_ID } from './agents/critic.agent.ts';
import { createBuilderAgent, BUILDER_AGENT_ID } from './agents/builder.agent.ts';
import { createIntentClassifierAgent, INTENT_CLASSIFIER_AGENT_ID } from './agents/intent-classifier.agent.ts';
import { createTurnInterpreterAgent, TURN_INTERPRETER_AGENT_ID } from './agents/turn-interpreter.agent.ts';

export interface MastraCompositionEnv extends ModelProviderEnv {
  STRATEGY_ANALYST_ADAPTER: 'fake' | 'mastra';
  STRATEGY_ANALYST_MODEL: string;
  RESEARCHER_ADAPTER: 'fake' | 'mastra';
  RESEARCHER_MODEL: string;
  CRITIC_ADAPTER: 'fake' | 'mastra';
  CRITIC_MODEL: string;
  ENABLE_CRITIC_AGENT: boolean;
  INTENT_CLASSIFIER_ADAPTER: 'fake' | 'mastra';
  INTENT_CLASSIFIER_MODEL: string;
  BUILDER_ADAPTER: 'fake' | 'mastra';
  BUILDER_MODEL: string;
}

export interface MastraAgentEntry {
  agent: Agent;
  label: string;
}

export interface MastraRuntime {
  mastra: Mastra;
  agents: {
    analyst?: MastraAgentEntry;
    researcher?: MastraAgentEntry;
    critic?: MastraAgentEntry;
    builder?: MastraAgentEntry;
    intentClassifier?: MastraAgentEntry;
    turnInterpreter?: MastraAgentEntry;
  };
}

export function composeMastra(env: MastraCompositionEnv): MastraRuntime {
  const registry: Record<string, Agent> = {};
  const labels: Record<string, string> = {};

  const build = (id: string, modelId: string, make: (m: ProviderModel) => Agent): void => {
    const resolved = resolveLanguageModel(env, modelId);
    registry[id] = make(resolved.model);
    labels[id] = resolved.label;
  };

  if (env.STRATEGY_ANALYST_ADAPTER === 'mastra') build(STRATEGY_ANALYST_AGENT_ID, env.STRATEGY_ANALYST_MODEL, createStrategyAnalystAgent);
  if (env.RESEARCHER_ADAPTER === 'mastra') build(RESEARCHER_AGENT_ID, env.RESEARCHER_MODEL, createResearcherAgent);
  if (env.ENABLE_CRITIC_AGENT && env.CRITIC_ADAPTER === 'mastra') build(CRITIC_AGENT_ID, env.CRITIC_MODEL, createCriticAgent);
  if (env.BUILDER_ADAPTER === 'mastra') build(BUILDER_AGENT_ID, env.BUILDER_MODEL, createBuilderAgent);
  if (env.INTENT_CLASSIFIER_ADAPTER === 'mastra') build(INTENT_CLASSIFIER_AGENT_ID, env.INTENT_CLASSIFIER_MODEL, createIntentClassifierAgent);
  // The chat turn interpreter shares the intent-classifier role/model selection.
  if (env.INTENT_CLASSIFIER_ADAPTER === 'mastra') build(TURN_INTERPRETER_AGENT_ID, env.INTENT_CLASSIFIER_MODEL, createTurnInterpreterAgent);

  const mastra = new Mastra({ agents: registry });

  // getAgent returns the same object registered above (identity holds in @mastra/core@1.41);
  // used here so adapters hold a Mastra-runtime-owned reference, not the pre-registration agent.
  const entry = (id: string): MastraAgentEntry | undefined =>
    registry[id] ? { agent: mastra.getAgent(id), label: labels[id]! } : undefined;

  return {
    mastra,
    agents: {
      analyst: entry(STRATEGY_ANALYST_AGENT_ID),
      researcher: entry(RESEARCHER_AGENT_ID),
      critic: entry(CRITIC_AGENT_ID),
      builder: entry(BUILDER_AGENT_ID),
      intentClassifier: entry(INTENT_CLASSIFIER_AGENT_ID),
      turnInterpreter: entry(TURN_INTERPRETER_AGENT_ID),
    },
  };
}
