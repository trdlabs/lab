// src/ports/strategy-similarity.port.ts
import type {
  StrategyCandidateSet,
  SimilarStrategyCandidate,
  StrategySimilarityQuery,
} from '../domain/strategy-retrieval.ts';

export interface StrategySimilarityPort {
  search(query: StrategySimilarityQuery): Promise<StrategyCandidateSet>;
}

/** Seam for an optional cross-encoder / LLM reranker. No implementation in this task. */
export interface RerankerPort {
  rerank(
    query: string,
    candidates: readonly SimilarStrategyCandidate[],
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly SimilarStrategyCandidate[]>;
}
