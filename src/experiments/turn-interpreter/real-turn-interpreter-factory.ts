// src/experiments/turn-interpreter/real-turn-interpreter-factory.ts
// IMPORTANT: this is the ONLY harness module that imports composeMastra / constructs real
// provider models. The CLI dynamically imports it ONLY under --run, so dry-run never loads it.
import { composeMastra, type MastraCompositionEnv } from '../../mastra/compose-mastra.ts';
import { MastraTurnInterpreter } from '../../adapters/intent/mastra-turn-interpreter.ts';
import { resolveLanguageModel, type ModelProviderEnv } from '../../adapters/llm/model-provider.ts';
import { createTurnInterpreterJudgeAgent } from '../../mastra/agents/turn-interpreter-judge.agent.ts';
import { JudgeVerdictSchema, type EvalCase, type JudgeVerdict } from './types.ts';
import type { TurnInterpreterPort } from '../../ports/turn-interpreter.port.ts';

function buildJudgePrompt(parsed: unknown, c: EvalCase): string {
  return [
    'You are evaluating a parsed InterpretedTurn against the original operator message.',
    '--- ORIGINAL MESSAGE START ---',
    c.message,
    '--- ORIGINAL MESSAGE END ---',
    '',
    '--- PARSED OUTPUT (JSON) START ---',
    JSON.stringify(parsed, null, 2),
    '--- PARSED OUTPUT END ---',
    '',
    `Expected: subject=${c.expect.subject}${c.expect.goal ? `, goal=${c.expect.goal}` : ''}${c.expect.hasStrategyText !== undefined ? `, hasStrategyText=${c.expect.hasStrategyText}` : ''}`,
    '',
    'Assess: (1) constraint faithfulness — no fabricated market/symbol/timeframe/direction not in the message; (2) subject accuracy; (3) goal accuracy; (4) strategyText capture quality.',
    'Return the structured judge verdict.',
  ].join('\n');
}

/** Build a composeMastra-backed turn interpreter for one candidate model (turn-interpreter='mastra', all else 'fake'). */
export function buildRealInterpreterFor(baseEnv: ModelProviderEnv): (modelId: string) => TurnInterpreterPort {
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
    const entry = runtime.agents.turnInterpreter;
    if (!entry) throw new Error('turn-interpreter agent was not composed (check INTENT_CLASSIFIER_ADAPTER)');
    return new MastraTurnInterpreter(entry.agent, entry.label);
  };
}

/** Build a per-case judge closure bound to a judge model. */
export function buildRealJudge(
  baseEnv: ModelProviderEnv,
  judgeModelId: string,
): (parsed: unknown, c: EvalCase) => Promise<JudgeVerdict> {
  const resolved = resolveLanguageModel(baseEnv, judgeModelId);
  const agent = createTurnInterpreterJudgeAgent(resolved.model);
  return async (parsed: unknown, c: EvalCase): Promise<JudgeVerdict> => {
    const result = await agent.generate(buildJudgePrompt(parsed, c), {
      structuredOutput: { schema: JudgeVerdictSchema },
    });
    return JudgeVerdictSchema.parse(result.object);
  };
}
