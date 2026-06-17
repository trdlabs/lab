// src/experiments/intent-classifier/real-classifier-factory.ts
// IMPORTANT: this is the ONLY harness module that imports composeMastra / constructs real
// provider models. The CLI dynamically imports it ONLY under --run, so dry-run never loads it.
import { composeMastra, type MastraCompositionEnv } from '../../mastra/compose-mastra.ts';
import { MastraIntentClassifier } from '../../adapters/intent/mastra-intent-classifier.ts';
import { resolveLanguageModel, type ModelProviderEnv } from '../../adapters/llm/model-provider.ts';
import { createIntentClassifierJudgeAgent } from '../../mastra/agents/intent-classifier-judge.agent.ts';
import { runJudge, type JudgeInput } from './judge.ts';
import { ChatIntentEvalSchema } from './openai-eval-schema.ts';
import type { IntentClassifierPort } from '../../ports/intent-classifier.port.ts';
import type { JudgeVerdict } from './types.ts';

/** Build a composeMastra-backed intent classifier for one candidate model (intent-classifier='mastra', all else 'fake'). */
export function buildRealClassifierFor(baseEnv: ModelProviderEnv): (modelId: string) => IntentClassifierPort {
  return (modelId: string) => {
    const env: MastraCompositionEnv = {
      ...baseEnv,
      INTENT_CLASSIFIER_ADAPTER: 'mastra',
      INTENT_CLASSIFIER_MODEL: modelId,
      STRATEGY_ANALYST_ADAPTER: 'fake',
      STRATEGY_ANALYST_MODEL: 'fake',
      RESEARCHER_ADAPTER: 'fake',
      RESEARCHER_MODEL: 'fake',
      CRITIC_ADAPTER: 'fake',
      CRITIC_MODEL: 'fake',
      ENABLE_CRITIC_AGENT: false,
      BUILDER_ADAPTER: 'fake',
      BUILDER_MODEL: 'fake',
    };
    const runtime = composeMastra(env);
    const entry = runtime.agents.intentClassifier;
    if (!entry) throw new Error('intent-classifier agent was not composed (check INTENT_CLASSIFIER_ADAPTER)');
    // 'raw': the eval harness re-validates via ChatIntentSchema (single trust boundary), so a schema
    // deviation must reach scoreCase as a per-case miss — not throw inside Mastra and kill the run.
    // requestSchema: OpenAI-strict-compatible variant (all keys required + optionals nullable) so
    // OpenAI models don't 400 on resolve; nulls are normalized away before the ChatIntentSchema gate.
    return new MastraIntentClassifier(entry.agent, entry.label, { schemaValidation: 'raw', requestSchema: ChatIntentEvalSchema });
  };
}

/** Build a batch-judge closure bound to a judge model. */
export function buildRealJudge(baseEnv: ModelProviderEnv, judgeModelId: string): (input: JudgeInput) => Promise<JudgeVerdict> {
  const resolved = resolveLanguageModel(baseEnv, judgeModelId);
  const agent = createIntentClassifierJudgeAgent(resolved.model);
  return (input: JudgeInput) => runJudge(agent, input);
}
