import { Mastra } from '@mastra/core';
import type { Agent } from '@mastra/core/agent';
import { ArizeExporter } from '@mastra/arize';
import { Observability } from '@mastra/observability';
import { resolveLanguageModel } from '../adapters/llm/model-provider.ts';
import type { ModelProviderEnv, ProviderModel } from '../adapters/llm/model-provider.ts';
import { createStrategyAnalystAgent, STRATEGY_ANALYST_AGENT_ID } from './agents/strategy-analyst.agent.ts';
import { createResearcherAgent, RESEARCHER_AGENT_ID } from './agents/researcher.agent.ts';
import { createCriticAgent, CRITIC_AGENT_ID } from './agents/critic.agent.ts';
import { createBuilderAgent, BUILDER_AGENT_ID } from './agents/builder.agent.ts';
import { createTurnInterpreterAgent, TURN_INTERPRETER_AGENT_ID } from './agents/turn-interpreter.agent.ts';
import { createStrategyCriticAgent, STRATEGY_CRITIC_AGENT_ID } from './agents/strategy-critic.agent.ts';
import { createStrategyRefinerAgent, STRATEGY_REFINER_AGENT_ID } from './agents/strategy-refiner.agent.ts';
import { createStrategyCriticCombinedAgent, STRATEGY_CRITIC_COMBINED_AGENT_ID } from './agents/strategy-critic-combined.agent.ts';
import { createGate1DecisionAgent, GATE1_DECISION_AGENT_ID } from './agents/gate1-decision.agent.ts';
import { createSweepDesignerAgent, SWEEP_DESIGNER_AGENT_ID } from './agents/sweep-designer.agent.ts';
import { createResultInterpreterAgent, RESULT_INTERPRETER_AGENT_ID } from './agents/result-interpreter.agent.ts';

export interface MastraCompositionEnv extends ModelProviderEnv {
  STRATEGY_ANALYST_ADAPTER: 'fake' | 'mastra';
  STRATEGY_ANALYST_MODEL: string;
  RESEARCHER_ADAPTER: 'fake' | 'mastra';
  RESEARCHER_MODEL: string;
  CRITIC_ADAPTER: 'fake' | 'mastra';
  CRITIC_MODEL: string;
  ENABLE_CRITIC_AGENT: boolean;
  TURN_INTERPRETER_ADAPTER: 'fake' | 'mastra';
  TURN_INTERPRETER_MODEL: string;
  BUILDER_ADAPTER: 'fake' | 'mastra';
  BUILDER_MODEL: string;
  STRATEGY_CRITIC_ADAPTER: 'fake' | 'mastra';
  STRATEGY_CRITIC_MODE: 'single' | 'two_stage';
  STRATEGY_CRITIC_MODEL: string;
  STRATEGY_REFINER_MODEL: string;
  WFO_GATE1_ADAPTER: 'fake' | 'mastra';
  WFO_GATE1_MODEL: string;
  WFO_SWEEP_DESIGNER_ADAPTER: 'fake' | 'mastra';
  WFO_SWEEP_DESIGNER_MODEL: string;
  WFO_RESULT_INTERPRETER_ADAPTER: 'fake' | 'mastra';
  WFO_RESULT_INTERPRETER_MODEL: string;
  PHOENIX_ENABLED: boolean;
  PHOENIX_COLLECTOR_ENDPOINT: string;
  PHOENIX_PROJECT_NAME: string;
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
    turnInterpreter?: MastraAgentEntry;
    strategyCritic?: MastraAgentEntry;
    strategyRefiner?: MastraAgentEntry;
    strategyCriticCombined?: MastraAgentEntry;
    gate1?: MastraAgentEntry;
    sweepDesigner?: MastraAgentEntry;
    resultInterpreter?: MastraAgentEntry;
  };
}

/**
 * Build the Phoenix/Arize observability config for the Mastra runtime.
 * Returns undefined when the flag is off so the `observability` key is omitted
 * entirely (zero overhead, no exporter constructed). Self-hosted Phoenix needs
 * no apiKey — only the OTLP collector endpoint.
 */
export function phoenixArizeConfig(
  env: MastraCompositionEnv,
): { serviceName: string; exporters: ArizeExporter[] } | undefined {
  if (!env.PHOENIX_ENABLED) return undefined;
  return {
    serviceName: env.PHOENIX_PROJECT_NAME,
    exporters: [
      new ArizeExporter({
        endpoint: env.PHOENIX_COLLECTOR_ENDPOINT,
        // Routes spans into a named Phoenix project (Phoenix groups by projectName,
        // not the OTel serviceName); without it traces fall into the "default" project.
        projectName: env.PHOENIX_PROJECT_NAME,
      }),
    ],
  };
}

/**
 * Build the Mastra-compatible Observability instance for the Phoenix/Arize path.
 * Returns `undefined` when the flag is off — lets callers spread conditionally so
 * no `observability` key is set on the Mastra constructor (zero overhead, no exporter
 * allocated). When enabled, returns a real `Observability` instance whose
 * `getDefaultInstance` method satisfies `@mastra/core@1.41`'s internal type-guard.
 */
export function phoenixObservability(env: MastraCompositionEnv): Observability | undefined {
  const arize = phoenixArizeConfig(env);
  return arize ? new Observability({ configs: { arize } }) : undefined;
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
  if (env.TURN_INTERPRETER_ADAPTER === 'mastra') build(TURN_INTERPRETER_AGENT_ID, env.TURN_INTERPRETER_MODEL, createTurnInterpreterAgent);

  if (env.STRATEGY_CRITIC_ADAPTER === 'mastra') {
    if (env.STRATEGY_CRITIC_MODE === 'two_stage') {
      build(STRATEGY_CRITIC_AGENT_ID, env.STRATEGY_CRITIC_MODEL, createStrategyCriticAgent);
      build(STRATEGY_REFINER_AGENT_ID, env.STRATEGY_REFINER_MODEL, createStrategyRefinerAgent);
    } else {
      build(STRATEGY_CRITIC_COMBINED_AGENT_ID, env.STRATEGY_CRITIC_MODEL, createStrategyCriticCombinedAgent);
    }
  }

  if (env.WFO_GATE1_ADAPTER === 'mastra') build(GATE1_DECISION_AGENT_ID, env.WFO_GATE1_MODEL, createGate1DecisionAgent);
  if (env.WFO_SWEEP_DESIGNER_ADAPTER === 'mastra') build(SWEEP_DESIGNER_AGENT_ID, env.WFO_SWEEP_DESIGNER_MODEL, createSweepDesignerAgent);
  if (env.WFO_RESULT_INTERPRETER_ADAPTER === 'mastra') build(RESULT_INTERPRETER_AGENT_ID, env.WFO_RESULT_INTERPRETER_MODEL, createResultInterpreterAgent);

  const observability = phoenixObservability(env);
  const mastra = new Mastra({
    agents: registry,
    ...(observability ? { observability } : {}),
  });

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
      turnInterpreter: entry(TURN_INTERPRETER_AGENT_ID),
      strategyCritic: entry(STRATEGY_CRITIC_AGENT_ID),
      strategyRefiner: entry(STRATEGY_REFINER_AGENT_ID),
      strategyCriticCombined: entry(STRATEGY_CRITIC_COMBINED_AGENT_ID),
      gate1: entry(GATE1_DECISION_AGENT_ID),
      sweepDesigner: entry(SWEEP_DESIGNER_AGENT_ID),
      resultInterpreter: entry(RESULT_INTERPRETER_AGENT_ID),
    },
  };
}
