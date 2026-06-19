// src/experiments/operator-rag/eval-harness.ts
// Pure eval engine: computes metrics + gate results from (retrieval results, fixtures).
// No I/O, no network, no DB — safe to unit-test deterministically.
import { recallAtK, reciprocalRank, ndcgAtK, mean } from './metrics.ts';
import type { StrategyRetrievalEvalCase, CaseRetrievalResult, CaseMetrics, GateResult, EvalRunResult } from './types.ts';

export const RECALL_AT_K = 20;
export const NDCG_AT_K = 5;
export const RECALL_GATE_THRESHOLD = 0.9;
export const HARNESS_VERSION = 'operator-rag-eval-v1';
export const CONTRACT_VERSION = 'strategy-retrieval-v1';

/** Port for executing one retrieval per case. Injected so the harness stays pure and testable. */
export interface RetrievalPort {
  retrieve(caseId: string, query: string, filters: StrategyRetrievalEvalCase['filters']): Promise<string[]>;
}

// ─── Pure computation ─────────────────────────────────────────────────────────

/**
 * Compute per-case metrics from retrieved ids + the eval case definition.
 * PURE — no I/O. Safe to call in unit tests.
 */
export function computeCaseMetrics(retrieved: CaseRetrievalResult, evalCase: StrategyRetrievalEvalCase): CaseMetrics {
  const retrievedIds = retrieved.error != null ? [] : retrieved.retrievedIds;

  const recall20 = recallAtK(retrievedIds, evalCase.expectedRelevantIds, RECALL_AT_K);
  const rr = reciprocalRank(retrievedIds, evalCase.expectedRelevantIds);
  const ndcg5 = ndcgAtK(retrievedIds, evalCase.gradedRelevance, NDCG_AT_K);

  let exactIdentityHit: boolean | null = null;
  if (evalCase.expectedExactId != null) {
    exactIdentityHit = retrievedIds.length > 0 && retrievedIds[0] === evalCase.expectedExactId;
  }

  // A "false semantic exact" is when:
  // - We have no expectedExactId (so this case is NOT an exact copy),
  // - AND the top-1 result has gradedRelevance = 3 (highest grade),
  // - AND there IS a top-1 result.
  // This indicates the system erroneously ranks a semantic duplicate as rank-1
  // when we expect a different document to be the best match.
  const top1Id = retrievedIds.length > 0 ? retrievedIds[0] : undefined;
  const falseSemanticExact =
    evalCase.expectedExactId == null &&
    top1Id !== undefined &&
    (evalCase.gradedRelevance[top1Id] ?? 0) === 3 &&
    // Only flag if grade-3 docs are NOT in expectedRelevantIds (i.e. unexpected)
    !evalCase.expectedRelevantIds.includes(top1Id);

  return {
    id: evalCase.id,
    hasRelevantDocs: evalCase.expectedRelevantIds.length > 0,
    recallAt20: recall20,
    reciprocalRank: rr,
    ndcgAt5: ndcg5,
    exactIdentityHit,
    falseSemanticExact,
  };
}

/**
 * Evaluate gate conditions from all case metrics.
 * PURE — no I/O. Safe to call in unit tests.
 */
export function evaluateGates(caseMetrics: CaseMetrics[]): GateResult {
  const exactCases = caseMetrics.filter((m) => m.exactIdentityHit !== null);
  const exactHits = exactCases.filter((m) => m.exactIdentityHit === true).length;
  const exactIdentityAccuracy = exactCases.length === 0 ? 1.0 : exactHits / exactCases.length;

  const falseSemanticExactCount = caseMetrics.filter((m) => m.falseSemanticExact).length;

  // Recall@k, MRR, and nDCG are undefined for no-match cases (no relevant docs).
  // Standard IR practice: exclude them from the aggregate means.
  const scored = caseMetrics.filter((m) => m.hasRelevantDocs);
  const recallAt20 = mean(scored.map((m) => m.recallAt20));
  const mrr = mean(scored.map((m) => m.reciprocalRank));
  const ndcgAt5 = mean(scored.map((m) => m.ndcgAt5));

  const gateExactIdentity = exactIdentityAccuracy === 1.0;
  const gateFalseSemanticExact = falseSemanticExactCount === 0;
  const gateRecallAt20 = recallAt20 >= RECALL_GATE_THRESHOLD;

  const overallPass = gateExactIdentity && gateFalseSemanticExact && gateRecallAt20;

  return {
    exactIdentityAccuracy,
    falseSemanticExactCount,
    recallAt20,
    mrr,
    ndcgAt5,
    gateExactIdentity,
    gateFalseSemanticExact,
    gateRecallAt20,
    overallPass,
  };
}

/**
 * Assemble a full EvalRunResult from retrieval results and the original eval cases.
 * PURE — no I/O. Safe to call in unit tests.
 */
export function assembleResult(
  datasetId: string,
  datasetFingerprint: string,
  cases: StrategyRetrievalEvalCase[],
  retrievalResults: CaseRetrievalResult[],
): EvalRunResult {
  const byId = new Map<string, CaseRetrievalResult>(retrievalResults.map((r) => [r.id, r]));
  const caseMetrics: CaseMetrics[] = cases.map((c) => {
    const retrieved = byId.get(c.id) ?? { id: c.id, query: c.query, retrievedIds: [], error: 'missing result' };
    return computeCaseMetrics(retrieved, c);
  });

  const gates = evaluateGates(caseMetrics);

  return {
    dataset: { id: datasetId, fingerprint: datasetFingerprint, caseCount: cases.length },
    caseMetrics,
    gates,
    overallPass: gates.overallPass,
  };
}

// ─── Live runner (requires adapter injection) ─────────────────────────────────

/**
 * Execute retrieval for every case using the injected port.
 * This is the ONLY function that performs I/O (via the adapter).
 * In dry-run the CLI must NOT call this function.
 */
export async function runRetrieval(
  cases: StrategyRetrievalEvalCase[],
  port: RetrievalPort,
): Promise<CaseRetrievalResult[]> {
  const results: CaseRetrievalResult[] = [];

  for (const c of cases) {
    try {
      const retrievedIds = await port.retrieve(c.id, c.query, c.filters);
      results.push({ id: c.id, query: c.query, retrievedIds, error: null });
    } catch (err) {
      results.push({
        id: c.id,
        query: c.query,
        retrievedIds: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
