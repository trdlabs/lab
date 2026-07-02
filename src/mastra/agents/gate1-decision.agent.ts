import { Agent } from '@mastra/core/agent';
import type { ProviderModel } from '../../adapters/llm/model-provider.ts';

export const GATE1_DECISION_AGENT_ID = 'gate1-decision';

const INSTRUCTIONS = [
  'You are GATE1, the go/no-go gate before a walk-forward-optimization (WFO) improvement round for a trading strategy.',
  'Given the strategy profile and its baseline train-period metrics, decide whether a sweep round is worth running.',
  'If the baseline already has trades (totalTrades >= 1), decision is "improve" — there is real signal to optimize against.',
  'If the baseline has ZERO trades, a sweep is only justified when BOTH conditions hold: there exist entry-affecting tunable',
  'parameters (params that could plausibly change whether trades fire at all) AND there is concrete entry-signal evidence',
  '(e.g. observed near-miss signals or documented entry-condition data) supporting that tuning those params would produce trades.',
  'Entry-affecting params alone are NOT sufficient — without entry-signal evidence, an exploratory sweep would be a waste of compute.',
  'In that case decision is "allow_exploratory_sweep". Otherwise, with a zero-trade baseline and missing either condition,',
  'decision is "stop_insufficient_evidence" — do not spend compute on a sweep with no evidentiary basis.',
  'Use "stop_not_worth" only when trades exist but the baseline is already clearly not improvable (e.g. degenerate/looks-final).',
  'Always give a short, concrete "reason" string explaining the decision.',
].join(' ');

export function createGate1DecisionAgent(model: ProviderModel): Agent {
  return new Agent({ id: GATE1_DECISION_AGENT_ID, name: 'Gate1Decision', instructions: INSTRUCTIONS, model });
}
