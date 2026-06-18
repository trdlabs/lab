import { composeMastra, type MastraCompositionEnv } from '../../mastra/compose-mastra.ts';
import { MastraBuilder } from '../../adapters/builder/mastra-builder.ts';
import { resolveLanguageModel, type ModelProviderEnv } from '../../adapters/llm/model-provider.ts';
import type { BuilderPort } from '../../ports/builder.port.ts';

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
      INTENT_CLASSIFIER_ADAPTER: 'fake',
      INTENT_CLASSIFIER_MODEL: 'fake',
      BUILDER_ADAPTER: 'mastra',
      BUILDER_MODEL: modelId,
    };
    const runtime = composeMastra(env);
    const entry = runtime.agents.builder;
    if (!entry) throw new Error('builder agent was not composed (check BUILDER_ADAPTER)');
    return new MastraBuilder(entry.agent, entry.label);
  };
}
