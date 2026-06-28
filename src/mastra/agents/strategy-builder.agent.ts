import { Agent } from '@mastra/core/agent';
import type { ProviderModel } from '../../adapters/llm/model-provider.ts';

export const STRATEGY_BUILDER_AGENT_ID = 'strategy-builder';

const STRATEGY_INSTRUCTIONS = [
  'You are a strategy module author for a trading platform.',
  'Given a strategy profile and a TASK instruction, emit a self-contained ESM strategy module.',
  'The module MUST export a default function: `export default function createStrategyModule(...)`.',
  'Use NO import or require statements — the module must be fully self-contained.',
  'Allowed lifecycle hooks: `onBarClose` and `onPositionBar` only. Do NOT use any other hooks.',
  'Set manifest.kind to "strategy". Do NOT include bundleHash or bytes — the host computes them.',
  'Author only the logic described in the strategy profile.',
  'Do NOT implement concerns listed under "Runner-Owned Authorities" (risk sizing, fills, execution).',
].join(' ');

export interface StrategyBuilderAgentDeps {
  model: ProviderModel;
  authoringDoc: string;
}

export function createStrategyBuilderAgent(deps: StrategyBuilderAgentDeps): Agent {
  const { model, authoringDoc } = deps;
  const instructions = `${STRATEGY_INSTRUCTIONS}\n\nSDK reference:\n${authoringDoc}`;
  return new Agent({
    id: STRATEGY_BUILDER_AGENT_ID,
    name: 'StrategyBuilder',
    instructions,
    model,
  });
}
