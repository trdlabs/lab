// src/experiments/strategy-analyst/real-analyst-factory.ts
// IMPORTANT: this is the ONLY harness module that imports composeMastra / constructs real
// provider models. The CLI dynamically imports it ONLY under --run, so dry-run never loads it.
import { composeMastra, type MastraCompositionEnv } from '../../mastra/compose-mastra.ts';
import { MastraStrategyAnalyst } from '../../adapters/analyst/mastra-strategy-analyst.ts';
import { resolveLanguageModel, type ModelProviderEnv } from '../../adapters/llm/model-provider.ts';
import { createStrategyAnalystJudgeAgent } from '../../mastra/agents/strategy-analyst-judge.agent.ts';
import { runJudge } from './judge.ts';
import type { StrategyAnalystPort } from '../../ports/strategy-analyst.port.ts';
import type { AnalystProfileOutput } from '../../domain/strategy-profile.ts';
import type { JudgeVerdict } from './types.ts';

/** Build a composeMastra-backed analyst for one candidate model (analyst='mastra', all else 'fake'). */
export function buildRealAnalystFor(baseEnv: ModelProviderEnv): (modelId: string) => StrategyAnalystPort {
  return (modelId: string) => {
    const env: MastraCompositionEnv = {
      ...baseEnv,
      STRATEGY_ANALYST_ADAPTER: 'mastra',
      STRATEGY_ANALYST_MODEL: modelId,
      RESEARCHER_ADAPTER: 'fake',
      RESEARCHER_MODEL: 'fake',
      CRITIC_ADAPTER: 'fake',
      CRITIC_MODEL: 'fake',
      ENABLE_CRITIC_AGENT: false,
      TURN_INTERPRETER_ADAPTER: 'fake',
      TURN_INTERPRETER_MODEL: 'fake',
      BUILDER_ADAPTER: 'fake',
      BUILDER_MODEL: 'fake',
    };
    const runtime = composeMastra(env);
    const entry = runtime.agents.analyst;
    if (!entry) throw new Error('analyst agent was not composed (check STRATEGY_ANALYST_ADAPTER)');
    return new MastraStrategyAnalyst(entry.agent, entry.label);
  };
}

/** Build a judge closure bound to a judge model + the rubric/notes text. */
export function buildRealJudge(
  baseEnv: ModelProviderEnv,
  judgeModelId: string,
  rubricText: string,
  notesText: string,
): (profile: AnalystProfileOutput) => Promise<JudgeVerdict> {
  const resolved = resolveLanguageModel(baseEnv, judgeModelId);
  const agent = createStrategyAnalystJudgeAgent(resolved.model);
  return (profile: AnalystProfileOutput) => runJudge(agent, { profile, rubricText, notesText });
}
