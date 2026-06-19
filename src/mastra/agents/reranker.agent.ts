// src/mastra/agents/reranker.agent.ts
//
// Factory for the MastraAgentRelevanceScorer used by MastraRerankerAdapter.
// Lives here to honour the @mastra/core value-import boundary (src/mastra/** only).

import { MastraAgentRelevanceScorer } from '@mastra/core/relevance';
import type { RelevanceScoreProvider } from '@mastra/core/relevance';
import type { ProviderModel } from '../../adapters/llm/model-provider.ts';

export const RERANKER_AGENT_ID = 'reranker';

/**
 * Creates a MastraAgentRelevanceScorer that scores candidate text against a query
 * using the provided LLM model (semantic scoring).
 *
 * Returns as RelevanceScoreProvider so callers outside src/mastra/** only see the port.
 */
export function createRerankerScorer(model: ProviderModel): RelevanceScoreProvider {
  return new MastraAgentRelevanceScorer(RERANKER_AGENT_ID, model);
}
