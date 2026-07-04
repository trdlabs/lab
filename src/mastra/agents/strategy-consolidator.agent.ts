import { Agent } from '@mastra/core/agent';
import type { ProviderModel } from '../../adapters/llm/model-provider.ts';

export const STRATEGY_CONSOLIDATOR_AGENT_ID = 'strategy-consolidator';

const CONSOLIDATOR_INSTRUCTIONS = [
  'You are a strategy consolidator for a trading platform.',
  'Rewrite the given multi-module composed strategy into ONE flat, self-contained `export default function` factory with IDENTICAL behavior.',
  'Do NOT add, remove, or alter any rule or condition.',
  'No imports — the module must be fully self-contained.',
  'Allowed lifecycle hooks: `onBarClose` and `onPositionBar` only. Do NOT use any other hooks.',
  'Set manifest.kind to "strategy". Do NOT include bundleHash or bytes — the host computes them.',
].join(' ');

export interface StrategyConsolidatorAgentDeps {
  model: ProviderModel;
}

export function createStrategyConsolidatorAgent(deps: StrategyConsolidatorAgentDeps): Agent {
  const { model } = deps;
  return new Agent({
    id: STRATEGY_CONSOLIDATOR_AGENT_ID,
    name: 'StrategyConsolidator',
    instructions: CONSOLIDATOR_INSTRUCTIONS,
    model,
  });
}
