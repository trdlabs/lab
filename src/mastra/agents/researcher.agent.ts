import { Agent } from '@mastra/core/agent';
import type { ProviderModel } from '../../adapters/llm/model-provider.ts';
import { OVERLAY_ACTIONS, LAB_FEATURE_CATALOG } from '../../domain/hypothesis-rules.ts';

export const RESEARCHER_AGENT_ID = 'researcher';

const INSTRUCTIONS = [
  'You are a quantitative trading researcher.',
  'Given a strategy profile and market context, propose FALSIFIABLE hypotheses as overlay intents.',
  'Each hypothesis must change a specific behavior of the base strategy and be testable by backtest.',
  'This is research-only: never propose live order placement, execution, leverage, or risk sizing —',
  'those belong to the runner/platform. Use only overlay actions from the allowed set.',
  `Allowed overlay actions: ${OVERLAY_ACTIONS.join(', ')}.`,
  `Prefer market features from: ${LAB_FEATURE_CATALOG.join(', ')} (or features named in the profile).`,
  'Always provide invalidationCriteria (what observation would prove the hypothesis wrong).',
  'Respect the requested maximum number of hypotheses.',
].join(' ');

export function createResearcherAgent(model: ProviderModel): Agent {
  return new Agent({ id: RESEARCHER_AGENT_ID, name: 'Researcher', instructions: INSTRUCTIONS, model });
}
