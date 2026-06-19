// src/adapters/reranker/mastra-reranker.adapter.ts
//
// Mastra-backed implementation of RerankerPort.
//
// Uses @mastra/core/relevance RelevanceScoreProvider (semantic/position scoring)
// to reorder SimilarStrategyCandidate[] by query relevance.
//
// Construction: inject a pre-built RelevanceScoreProvider.
// The concrete scorer (MastraAgentRelevanceScorer) lives in src/mastra/agents/reranker.agent.ts
// so that the @mastra/core value-import boundary is respected.
//
// Candidate text: composed from StrategyRetrievalMetadata fields (label, market, symbol,
// timeframe, direction) since SimilarStrategyCandidate does not carry full strategy text.
// Open item for live enablement: feed richer content (e.g. strategy description from
// StrategyRetrievalDocument.content) once available in the candidate payload.

import type { RelevanceScoreProvider } from '@mastra/core/relevance';
import type { RerankerPort } from '../../ports/strategy-similarity.port.ts';
import type {
  SimilarStrategyCandidate,
  StrategyRetrievalMetadata,
} from '../../domain/strategy-retrieval.ts';

// Scoring weights: semantic relevance dominates; position preserves some original order.
const SEMANTIC_WEIGHT = 0.7;
const POSITION_WEIGHT = 0.3;

/** Build a short text description from metadata fields for the scorer. */
function candidateText(metadata: StrategyRetrievalMetadata): string {
  const parts: string[] = [];
  if (metadata.label) parts.push(metadata.label);
  if (metadata.market) parts.push(metadata.market);
  if (metadata.symbol) parts.push(metadata.symbol);
  if (metadata.timeframe) parts.push(metadata.timeframe);
  if (metadata.direction) parts.push(metadata.direction);
  return parts.join(' ') || 'strategy';
}

/** Throws a DOMException AbortError with the appropriate cause. */
function throwAbortError(signal: AbortSignal): never {
  throw new DOMException(
    signal.reason instanceof Error ? signal.reason.message : 'Rerank aborted',
    'AbortError',
  );
}

/**
 * Mastra implementation of RerankerPort.
 *
 * Scores each candidate against the query using a RelevanceScoreProvider
 * (semantic/position scoring — NOT a cross-encoder), then returns the top
 * `limit` candidates in relevance-descending order.
 *
 * NO TS parameter properties (strip-types safe). All fields assigned in ctor body.
 */
export class MastraRerankerAdapter implements RerankerPort {
  private readonly scorer: RelevanceScoreProvider;

  constructor(scorer: RelevanceScoreProvider) {
    this.scorer = scorer;
  }

  async rerank(
    query: string,
    candidates: readonly SimilarStrategyCandidate[],
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly SimilarStrategyCandidate[]> {
    if (signal?.aborted) throwAbortError(signal);

    const total = candidates.length;

    // Score each candidate. Bail on abort between candidates.
    const scored: Array<{ candidate: SimilarStrategyCandidate; score: number }> = [];
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throwAbortError(signal);

      const candidate = candidates[i]!;
      const text = candidateText(candidate.metadata);
      const semantic = await this.scorer.getRelevanceScore(query, text);

      // position score: first candidate (index 0) = 1.0, last = ~0
      const position = total > 1 ? 1 - i / (total - 1) : 1;

      const combined = SEMANTIC_WEIGHT * semantic + POSITION_WEIGHT * position;
      scored.push({ candidate, score: combined });
    }

    if (signal?.aborted) throwAbortError(signal);

    // Sort descending by combined score, stable (preserve index order for ties)
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map((s) => s.candidate);
  }
}
