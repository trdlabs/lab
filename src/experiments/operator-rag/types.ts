// src/experiments/operator-rag/types.ts
// Shared contracts for the operator RAG retrieval eval harness.
// Mirrors the style of src/experiments/intent-classifier/types.ts but the unit
// of work is a labelled retrieval query rather than a classified chat message.

export type EvalMode = 'dry-run' | 'run';

/** A single labelled retrieval eval case. */
export interface StrategyRetrievalEvalCase {
  /** Stable identifier (used as primary key in results + reports). */
  id: string;
  /** The natural-language query the operator would type. */
  query: string;
  /** Dominant language of the query text. */
  language: 'ru' | 'en' | 'mixed';
  /** Metadata filters to pass alongside the query (may be empty). */
  filters: {
    market?: string;
    symbol?: string;
    timeframe?: string;
    direction?: 'long' | 'short' | 'both';
  };
  /** Ids that SHOULD appear in the top-k result for Recall@k and MRR. */
  expectedRelevantIds: string[];
  /** Graded relevance scores 0..3 for every id that is meaningful to judge
   *  (0 = irrelevant, 1 = marginally relevant, 2 = relevant, 3 = highly relevant).
   *  Ids not listed here are treated as grade 0 in nDCG computations. */
  gradedRelevance: Record<string, 0 | 1 | 2 | 3>;
  /** When set, this single id MUST be rank-1 (exact identity match gate). */
  expectedExactId?: string;
}

// ─── Per-case retrieval result ──────────────────────────────────────────────

export interface CaseRetrievalResult {
  id: string;
  query: string;
  /** Ids returned by the similarity search in ranked order (best first). */
  retrievedIds: string[];
  /** Populated when --run is active; null in dry-run or on error. */
  error: string | null;
}

// ─── Computed metrics for a single case ─────────────────────────────────────

export interface CaseMetrics {
  id: string;
  /** true when expectedRelevantIds is non-empty; false for no-match cases.
   *  Recall@k, MRR, and nDCG are UNDEFINED (and therefore EXCLUDED from
   *  their aggregate means) when hasRelevantDocs is false. */
  hasRelevantDocs: boolean;
  recallAt20: number;
  reciprocalRank: number;
  ndcgAt5: number;
  /** true when expectedExactId is present AND ranks first in retrievedIds. */
  exactIdentityHit: boolean | null; // null when expectedExactId absent
  /** true when the top-1 result was asserted as an exact duplicate by its
   *  grade = 3 AND expectedExactId is absent (false semantic exact). */
  falseSemanticExact: boolean;
}

// ─── Aggregate gate result ───────────────────────────────────────────────────

export interface GateResult {
  exactIdentityAccuracy: number; // fraction of cases with expectedExactId where exact hit = 1.0
  falseSemanticExactCount: number; // # cases where top-1 is incorrectly asserted as exact
  recallAt20: number; // mean Recall@20 over cases WITH relevant docs (hasRelevantDocs=true)
  mrr: number; // Mean Reciprocal Rank over cases WITH relevant docs
  ndcgAt5: number; // mean nDCG@5 over cases WITH relevant docs
  // Pass/fail per gate
  gateExactIdentity: boolean; // exactIdentityAccuracy === 1.0
  gateFalseSemanticExact: boolean; // falseSemanticExactCount === 0
  gateRecallAt20: boolean; // recallAt20 >= 0.90
  overallPass: boolean;
}

// ─── Full eval run result ────────────────────────────────────────────────────

export interface EvalRunResult {
  dataset: { id: string; fingerprint: string; caseCount: number };
  caseMetrics: CaseMetrics[];
  gates: GateResult;
  overallPass: boolean;
}

// ─── Manifest meta (written alongside artifacts) ─────────────────────────────

export interface ManifestMeta {
  timestamp: string;
  gitSha: string;
  harnessVersion: string;
  contractVersion: string;
  mode: EvalMode;
}
