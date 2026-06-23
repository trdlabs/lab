import { composeMastra, type MastraCompositionEnv } from '../../mastra/compose-mastra.ts';
import { MastraBuilder } from '../../adapters/builder/mastra-builder.ts';
import { resolveLanguageModel, type ModelProviderEnv } from '../../adapters/llm/model-provider.ts';
import type { BuilderPort } from '../../ports/builder.port.ts';
import { createBuilderJudgeAgent } from '../../mastra/agents/builder-judge.agent.ts';
import { runBuilderJudge } from './judge.ts';
import type { BuilderJudgeVerdict } from './types.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';
import type { BuilderOutput } from '../../ports/builder.port.ts';

export function buildRealBuilderFor(baseEnv: ModelProviderEnv): (modelId: string) => BuilderPort {
  return (modelId: string) => {
    const env: MastraCompositionEnv = {
      ...baseEnv,
      STRATEGY_ANALYST_ADAPTER: 'fake',
      STRATEGY_ANALYST_MODEL: 'fake',
      RESEARCHER_ADAPTER: 'fake',
      RESEARCHER_MODEL: 'fake',
      CRITIC_ADAPTER: 'fake',
      CRITIC_MODEL: 'fake',
      ENABLE_CRITIC_AGENT: false,
      TURN_INTERPRETER_ADAPTER: 'fake',
      TURN_INTERPRETER_MODEL: 'fake',
      BUILDER_ADAPTER: 'mastra',
      BUILDER_MODEL: modelId,
    };
    const runtime = composeMastra(env);
    const entry = runtime.agents.builder;
    if (!entry) throw new Error('builder agent was not composed (check BUILDER_ADAPTER)');
    return new MastraBuilder(entry.agent, entry.label);
  };
}

export function buildRealJudgeFor(
  baseEnv: ModelProviderEnv,
  judgeModelId: string,
): (hypothesis: HypothesisProposal, output: BuilderOutput) => Promise<BuilderJudgeVerdict> {
  const resolved = resolveLanguageModel(baseEnv, judgeModelId);
  const agent = createBuilderJudgeAgent(resolved.model);
  return (hypothesis, output) => runBuilderJudge(agent, { hypothesis, output });
}
