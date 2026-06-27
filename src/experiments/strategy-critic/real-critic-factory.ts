// src/experiments/strategy-critic/real-critic-factory.ts
// IMPORTANT: the ONLY harness module that imports composeMastra / constructs real provider
// models. The CLI dynamically imports it ONLY under --run, so dry-run never loads it.
import { composeMastra, type MastraCompositionEnv } from '../../mastra/compose-mastra.ts';
import { TwoStageStrategyCritic } from '../../adapters/strategy-critic/two-stage-strategy-critic.ts';
import { SingleStageStrategyCritic } from '../../adapters/strategy-critic/single-stage-strategy-critic.ts';
import { resolveLanguageModel, type ModelProviderEnv } from '../../adapters/llm/model-provider.ts';
import { createStrategyCriticJudgeAgent } from '../../mastra/agents/strategy-critic-judge.agent.ts';
import { runJudge } from './judge.ts';
import type { StrategyCriticPort } from '../../ports/strategy-critic.port.ts';
import type { StrategyRefinement } from '../../domain/strategy-critic.ts';
import type { AnalystProfileOutput } from '../../domain/strategy-profile.ts';
import type { Candidate, CriticEvalCase, JudgeVerdict } from './types.ts';

/** Base composition env: every adapter 'fake' except the strategy critic (set per candidate). */
function baseCompositionEnv(baseEnv: ModelProviderEnv): MastraCompositionEnv {
  return {
    ...baseEnv,
    STRATEGY_ANALYST_ADAPTER: 'fake', STRATEGY_ANALYST_MODEL: 'fake',
    RESEARCHER_ADAPTER: 'fake', RESEARCHER_MODEL: 'fake',
    CRITIC_ADAPTER: 'fake', CRITIC_MODEL: 'fake', ENABLE_CRITIC_AGENT: false,
    TURN_INTERPRETER_ADAPTER: 'fake', TURN_INTERPRETER_MODEL: 'fake',
    BUILDER_ADAPTER: 'fake', BUILDER_MODEL: 'fake',
    STRATEGY_CRITIC_ADAPTER: 'mastra',
    STRATEGY_CRITIC_MODE: 'two_stage',
    STRATEGY_CRITIC_MODEL: 'fake',
    STRATEGY_REFINER_MODEL: 'fake',
    PHOENIX_ENABLED: false,
    PHOENIX_COLLECTOR_ENDPOINT: 'http://localhost:6006/v1/traces',
    PHOENIX_PROJECT_NAME: 'trading-lab',
  };
}

/** Build a composeMastra-backed critic for one candidate (mirrors buildStrategyCritic selection). */
export function buildRealCriticFor(baseEnv: ModelProviderEnv): (candidate: Candidate) => StrategyCriticPort {
  return (candidate: Candidate) => {
    if (candidate.mode === 'single') {
      const env: MastraCompositionEnv = { ...baseCompositionEnv(baseEnv), STRATEGY_CRITIC_MODE: 'single', STRATEGY_CRITIC_MODEL: candidate.combinedModel };
      const rt = composeMastra(env);
      const combined = rt.agents.strategyCriticCombined;
      if (!combined) throw new Error('strategy-critic-combined agent was not composed (check STRATEGY_CRITIC_ADAPTER)');
      return new SingleStageStrategyCritic(combined.agent, combined.label);
    }
    const env: MastraCompositionEnv = { ...baseCompositionEnv(baseEnv), STRATEGY_CRITIC_MODE: 'two_stage', STRATEGY_CRITIC_MODEL: candidate.criticModel, STRATEGY_REFINER_MODEL: candidate.refinerModel };
    const rt = composeMastra(env);
    const critic = rt.agents.strategyCritic;
    const refiner = rt.agents.strategyRefiner;
    if (!critic || !refiner) throw new Error('strategy-critic / strategy-refiner agents were not composed (check STRATEGY_CRITIC_ADAPTER)');
    return new TwoStageStrategyCritic(critic.agent, refiner.agent, critic.label, refiner.label);
  };
}

/** Build a best-effort judge closure bound to a judge model. */
export function buildRealJudge(
  baseEnv: ModelProviderEnv,
  judgeModelId: string,
): (refinement: StrategyRefinement, evalCase: CriticEvalCase, profile?: AnalystProfileOutput) => Promise<JudgeVerdict> {
  const resolved = resolveLanguageModel(baseEnv, judgeModelId);
  const agent = createStrategyCriticJudgeAgent(resolved.model);
  return (refinement: StrategyRefinement, evalCase: CriticEvalCase, profile?: AnalystProfileOutput) =>
    runJudge(agent, { originalText: evalCase.text, refinement, profile });
}
