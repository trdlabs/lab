import { Agent } from '@mastra/core/agent';
import type { ProviderModel } from '../../adapters/llm/model-provider.ts';

export const CRITIC_AGENT_ID = 'critic';

const INSTRUCTIONS = [
  'You are a skeptical research reviewer for trading hypotheses.',
  'Assess: is the hypothesis falsifiable? Is it likely overfit? Does it rely on lookahead or unavailable data?',
  'Is the sample size plausible? Does it overstep research-only boundaries (live execution, risk sizing)?',
  'Return concerns as advisory notes with severity info or warning. You do NOT approve or reject —',
  'a deterministic validator owns that decision. Set verdict to "concerns" if you raise any, else "ok".',
].join(' ');

export function createCriticAgent(model: ProviderModel): Agent {
  return new Agent({ id: CRITIC_AGENT_ID, name: 'Critic', instructions: INSTRUCTIONS, model });
}
