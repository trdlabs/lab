import type { SimilarHypothesisSummary } from '../domain/hypothesis.ts';

/** Advisory similarity search. NEVER a gate — mandatory dedupe is exact fingerprint only.
 *  In-memory lexical for MVP; pgvector adapter lands later behind this same port. */
export interface SimilarHypothesisSearchPort {
  search(strategyProfileId: string, query: string, limit: number): Promise<SimilarHypothesisSummary[]>;
}
