import { composeMastra, type MastraCompositionEnv } from '../../mastra/compose-mastra.ts';
import { MastraResearcher } from '../../adapters/researcher/mastra-researcher.ts';
import { createResearcherJudgeAgent } from '../../mastra/agents/researcher-judge.agent.ts';
import { runJudge } from './judge.ts';
import { resolveLanguageModel, type ModelProviderEnv } from '../../adapters/llm/model-provider.ts';
import type { ResearcherPort } from '../../ports/researcher.port.ts';
import type { JudgeVerdict, ResearcherEvalInput } from './types.ts';
import type { ResearcherOutput } from '../../domain/hypothesis.ts';

export function buildRealResearcherFor(baseEnv: ModelProviderEnv): (modelId: string) => ResearcherPort {
  return (modelId: string) => {
    const env: MastraCompositionEnv = {
      ...baseEnv,
      STRATEGY_ANALYST_ADAPTER: 'fake',
      STRATEGY_ANALYST_MODEL: 'fake',
      RESEARCHER_ADAPTER: 'mastra',
      RESEARCHER_MODEL: modelId,
      CRITIC_ADAPTER: 'fake',
      CRITIC_MODEL: 'fake',
      ENABLE_CRITIC_AGENT: false,
      TURN_INTERPRETER_ADAPTER: 'fake',
      TURN_INTERPRETER_MODEL: 'fake',
      BUILDER_ADAPTER: 'fake',
      BUILDER_MODEL: 'fake',
      PHOENIX_ENABLED: false,
      PHOENIX_COLLECTOR_ENDPOINT: 'http://localhost:6006/v1/traces',
      PHOENIX_PROJECT_NAME: 'trading-lab',
    };
    const runtime = composeMastra(env);
    const entry = runtime.agents.researcher;
    if (!entry) throw new Error('researcher agent was not composed (check RESEARCHER_ADAPTER)');
    return new MastraResearcher(entry.agent, entry.label);
  };
}

export function buildRealJudgeFor(
  baseEnv: ModelProviderEnv,
  judgeModelId: string,
): (output: ResearcherOutput | null, input: ResearcherEvalInput) => Promise<JudgeVerdict> {
  const resolved = resolveLanguageModel(baseEnv, judgeModelId);
  const agent = createResearcherJudgeAgent(resolved.model);
  return async (output, input) => {
    if (!output) throw new Error('no output to judge');
    return runJudge(agent, {
      output,
      profile: input.profile,
      botResults: input.botResults,
      tradeEvidence: input.tradeEvidence,
    });
  };
}
