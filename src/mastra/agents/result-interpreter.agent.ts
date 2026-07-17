import { Agent } from '@mastra/core/agent';
import type { ProviderModel } from '../../adapters/llm/model-provider.ts';

export const RESULT_INTERPRETER_AGENT_ID = 'result-interpreter';

const INSTRUCTIONS = [
  'You interpret the top-N ranked results of one walk-forward-optimization (WFO) sweep round for a trading strategy.',
  'Given the ranked candidate points (each with its metrics and a lowConfidence flag) plus how many rounds have run so far',
  'out of the max allowed, decide one of three outcomes:',
  '"select" — one candidate is clearly good enough to adopt; set chosenParamsHash to that candidate\'s paramsHash (it MUST',
  'match one of the provided top-N paramsHashes).',
  '"extend" — results are promising but inconclusive and more rounds remain (roundsSoFar < maxRounds); optionally set an',
  '"extendHint" string describing what the next round should try.',
  '"stop" — no candidates are worth extending further, or the top-N list is empty, or the round budget is exhausted.',
  'You only see backtest data from the training window — never reason about or assume data beyond it, to avoid lookahead / leakage into the holdout period.',
].join(' ');

export function createResultInterpreterAgent(model: ProviderModel): Agent {
  return new Agent({ id: RESULT_INTERPRETER_AGENT_ID, name: 'ResultInterpreter', instructions: INSTRUCTIONS, model });
}
