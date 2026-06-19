// src/experiments/operator-rag/metrics.ts
// IR evaluation metrics: Recall@k, Reciprocal Rank, and nDCG@k.
// All functions are PURE — no I/O, no side effects.

/** Round a number to a fixed number of decimal places for deterministic comparisons. */
export function round(value: number, decimals: number = 6): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/**
 * Recall@k — fraction of relevant ids that appear in the top-k retrieved results.
 *
 * Formula: |relevant ∩ retrieved[0..k]| / |relevant|
 *
 * - Returns 0 when relevantIds is empty (no relevant docs → no recall possible).
 * - k is clamped to retrievedIds.length if k > len(retrieved).
 */
export function recallAtK(retrievedIds: string[], relevantIds: string[], k: number): number {
  if (relevantIds.length === 0) return 0;
  const topK = retrievedIds.slice(0, k);
  const relevant = new Set(relevantIds);
  const hits = topK.filter((id) => relevant.has(id)).length;
  return round(hits / relevantIds.length);
}

/**
 * Reciprocal Rank — 1 / rank of the first relevant result (1-based), or 0 if none found.
 *
 * Formula: 1/rank_first_relevant, or 0 when no relevant doc is retrieved.
 *
 * - Returns 0 when relevantIds is empty or no relevant id appears in retrievedIds.
 */
export function reciprocalRank(retrievedIds: string[], relevantIds: string[]): number {
  if (relevantIds.length === 0) return 0;
  const relevant = new Set(relevantIds);
  for (let i = 0; i < retrievedIds.length; i++) {
    const id = retrievedIds[i];
    if (id !== undefined && relevant.has(id)) {
      // 1-based rank
      return round(1 / (i + 1));
    }
  }
  return 0;
}

/**
 * Discounted Cumulative Gain up to rank k using graded relevance.
 *
 * DCG = sum_{i=1}^{k} (2^grade_i - 1) / log2(i + 1)
 *
 * Ids not present in gradedRelevance are treated as grade 0.
 */
function dcg(retrievedIds: string[], gradedRelevance: Record<string, 0 | 1 | 2 | 3>, k: number): number {
  let dcgValue = 0;
  const topK = retrievedIds.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    const id = topK[i];
    if (id === undefined) continue;
    const grade = gradedRelevance[id] ?? 0;
    dcgValue += (Math.pow(2, grade) - 1) / Math.log2(i + 2); // i+2 because log2(rank+1), rank = i+1
  }
  return dcgValue;
}

/**
 * Ideal DCG — computed from the top-k grades in sorted (descending) order.
 */
function idcg(gradedRelevance: Record<string, 0 | 1 | 2 | 3>, k: number): number {
  const grades = Object.values(gradedRelevance)
    .filter((g): g is 1 | 2 | 3 => g > 0)
    .sort((a, b) => b - a)
    .slice(0, k);

  let idcgValue = 0;
  for (let i = 0; i < grades.length; i++) {
    const grade = grades[i];
    if (grade === undefined) continue;
    idcgValue += (Math.pow(2, grade) - 1) / Math.log2(i + 2);
  }
  return idcgValue;
}

/**
 * nDCG@k — normalised Discounted Cumulative Gain at rank k.
 *
 * Formula: DCG@k / IDCG@k
 *
 * - Returns 0 when gradedRelevance has no entries with grade > 0 (IDCG = 0).
 * - Returns 0 when retrievedIds is empty.
 * - Result is in [0, 1].
 */
export function ndcgAtK(retrievedIds: string[], gradedRelevance: Record<string, 0 | 1 | 2 | 3>, k: number): number {
  const idealDcg = idcg(gradedRelevance, k);
  if (idealDcg === 0) return 0;
  const actualDcg = dcg(retrievedIds, gradedRelevance, k);
  return round(actualDcg / idealDcg);
}

// ─── Aggregate helpers ────────────────────────────────────────────────────────

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return round(values.reduce((s, v) => s + v, 0) / values.length);
}
