import { Agent } from '@mastra/core/agent';
import type { ProviderModel } from '../../adapters/llm/model-provider.ts';

export const STRATEGY_ANALYST_AGENT_ID = 'strategy-analyst';

const INSTRUCTIONS = [
  'You are a trading-strategy analyst.',
  'Given a strategy source (code, README, article, summary, or description), extract a structured profile.',
  'Do not invent details; put anything you are unsure about in `unknowns`.',
  'Anything that belongs to risk sizing, order execution, or fills is owned by the runner/platform —',
  'list those concerns in `runnerOwnedAuthorities`, do not propose live execution.',
  'Mark tunable parameters with tunable: true.',
].join(' ');

export function createStrategyAnalystAgent(model: ProviderModel): Agent {
  return new Agent({ id: STRATEGY_ANALYST_AGENT_ID, name: 'Strategy Analyst', instructions: INSTRUCTIONS, model });
}
