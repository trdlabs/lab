// src/experiments/wfo-gate1/real-gate1-factory.ts
// IMPORTANT: this is the ONLY harness module that imports composeMastra / constructs real
// provider models. The CLI dynamically imports it ONLY under --run/--label, so dry-run never
// loads it.
import { composeMastra, type MastraCompositionEnv } from '../../mastra/compose-mastra.ts';
import { MastraGate1 } from '../../adapters/wfo/mastra-gate1.ts';
import type { ModelProviderEnv } from '../../adapters/llm/model-provider.ts';
import type { Gate1DecisionPort } from '../../ports/wfo-agents.port.ts';
import type { TeacherLabeler } from './teacher.ts';

/** Build a composeMastra-backed Gate1 decision port for one candidate model (gate1='mastra', all else 'fake'). */
export function buildRealGate1For(baseEnv: ModelProviderEnv): (modelId: string) => Gate1DecisionPort {
  return (modelId: string) => {
    const env: MastraCompositionEnv = {
      ...baseEnv,
      TURN_INTERPRETER_ADAPTER: 'fake',
      TURN_INTERPRETER_MODEL: 'fake',
      STRATEGY_ANALYST_ADAPTER: 'fake',
      STRATEGY_ANALYST_MODEL: 'fake',
      RESEARCHER_ADAPTER: 'fake',
      RESEARCHER_MODEL: 'fake',
      CRITIC_ADAPTER: 'fake',
      CRITIC_MODEL: 'fake',
      ENABLE_CRITIC_AGENT: false,
      BUILDER_ADAPTER: 'fake',
      BUILDER_MODEL: 'fake',
      STRATEGY_CRITIC_ADAPTER: 'fake',
      STRATEGY_CRITIC_MODE: 'two_stage',
      STRATEGY_CRITIC_MODEL: 'fake',
      STRATEGY_REFINER_MODEL: 'fake',
      WFO_GATE1_ADAPTER: 'mastra',
      WFO_GATE1_MODEL: modelId,
      WFO_SWEEP_DESIGNER_ADAPTER: 'fake',
      WFO_SWEEP_DESIGNER_MODEL: 'fake',
      WFO_RESULT_INTERPRETER_ADAPTER: 'fake',
      WFO_RESULT_INTERPRETER_MODEL: 'fake',
      PHOENIX_ENABLED: false,
      PHOENIX_COLLECTOR_ENDPOINT: 'http://localhost:6006/v1/traces',
      PHOENIX_PROJECT_NAME: 'trading-lab',
    };
    const runtime = composeMastra(env);
    const entry = runtime.agents.gate1;
    if (!entry) throw new Error('gate1 agent was not composed (check WFO_GATE1_ADAPTER)');
    return new MastraGate1(entry.agent, entry.label);
  };
}

/** Build a real Gate1-backed teacher labeler bound to a teacher model. */
export function buildRealTeacher(baseEnv: ModelProviderEnv, teacherModelId: string): TeacherLabeler {
  const gate1 = buildRealGate1For(baseEnv)(teacherModelId);
  return async (input) => {
    const out = await gate1.decide(input);
    return { label: out.decision, rationale: out.reason };
  };
}
