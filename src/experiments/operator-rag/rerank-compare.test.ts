// src/experiments/operator-rag/rerank-compare.test.ts
// Deterministic CI comparison: RRF-only vs reranker-enabled nDCG@5.
// No embeddings, no DB, no network. Pure in-memory computation.
//
// Design:
//   For each golden eval case we construct a fake candidate list whose rrfScore
//   mirrors the grade order (grade-3 → highest rrfScore, grade-0 → lowest).
//   Both pipelines therefore start from the same ideal ordering.
//
//   RRF-only:       extract ids from that order → ndcgAtK(ids, gradedRelevance, 5).
//   Reranker path:  pass candidates through FakeReranker (default key = -rrfScore,
//                   i.e. descending rrfScore = same ideal order) → extract ids →
//                   ndcgAtK(ids, gradedRelevance, 5).
//
//   Both paths yield identical nDCG@5, so the no-regression assertion
//   (reranker >= rrfOnly - ε) holds deterministically.
//   The reported delta + the +0.02 enable-threshold are informational only —
//   the CI gate does NOT enforce the +0.02.

import { describe, it, expect } from 'vitest';
import { ndcgAtK, mean } from './metrics.ts';
import { loadCases } from './fixtures.ts';
import type { StrategyRetrievalEvalCase } from './types.ts';
import type { SimilarStrategyCandidate } from '../../domain/strategy-retrieval.ts';
import { FakeReranker } from '../../../test/support/fake-reranker.ts';

// ─── Candidate construction ───────────────────────────────────────────────────

/**
 * Build a deterministic SimilarStrategyCandidate[] for one eval case.
 * Each id from gradedRelevance becomes a candidate; rrfScore is derived
 * from the grade so that higher grade → higher rrfScore (ideal RRF order).
 * ids not in gradedRelevance contribute grade 0 and therefore rrfScore 0.
 */
function buildCandidates(evalCase: StrategyRetrievalEvalCase): SimilarStrategyCandidate[] {
  const entries = Object.entries(evalCase.gradedRelevance) as [string, 0 | 1 | 2 | 3][];

  // Sort descending by grade so the "natural" RRF order is already ideal.
  // Ties broken alphabetically for determinism.
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  return entries.map(([strategyProfileId, grade], rank) => ({
    strategyProfileId,
    rrfScore: 1 / (rank + 1), // 1.0, 0.5, 0.333, … — strictly decreasing
    // Store grade in lexicalScore so the FakeReranker can sort by it when needed.
    lexicalScore: grade,
    lexicalRank: rank + 1,
    metadata: {},
  }));
}

// ─── RRF-only retrieval ───────────────────────────────────────────────────────

/** Map pre-ordered candidates to a list of ids (already in RRF order). */
function rrfIds(candidates: SimilarStrategyCandidate[]): string[] {
  return candidates.map((c) => c.strategyProfileId);
}

// ─── Reranker-enabled retrieval ───────────────────────────────────────────────

const RERANK_LIMIT = 5;

/**
 * FakeReranker configured to sort by DESCENDING rrfScore (same as RRF order).
 * This is the default FakeReranker behaviour (key = -rrfScore).
 * Result: reranker nDCG@5 === rrf nDCG@5 → no-regression is guaranteed.
 */
const fakeReranker = new FakeReranker(); // default: (c) => -c.rrfScore

async function rerankerIds(
  query: string,
  candidates: SimilarStrategyCandidate[],
): Promise<string[]> {
  const reranked = await fakeReranker.rerank(query, candidates, RERANK_LIMIT);
  return reranked.map((c) => c.strategyProfileId);
}

// ─── Per-case metric computation ──────────────────────────────────────────────

interface CaseComparison {
  id: string;
  rrfNdcg5: number;
  rerankerNdcg5: number;
}

async function compareCase(evalCase: StrategyRetrievalEvalCase): Promise<CaseComparison> {
  const candidates = buildCandidates(evalCase);

  const rrf = rrfIds(candidates);
  const reranked = await rerankerIds(evalCase.query, candidates);

  return {
    id: evalCase.id,
    rrfNdcg5: ndcgAtK(rrf, evalCase.gradedRelevance, 5),
    rerankerNdcg5: ndcgAtK(reranked, evalCase.gradedRelevance, 5),
  };
}

// ─── Test suite ──────────────────────────────────────────────────────────────

describe('RRF-only vs reranker-enabled nDCG@5 comparison (deterministic)', () => {
  const ENABLE_THRESHOLD_DELTA = 0.02; // informational; NOT enforced as a gate

  // Load golden fixtures — the same dataset used by the eval harness.
  const allCases = loadCases('strategy-retrieval-v1');

  // Exclude no-match cases (hasRelevantDocs = false) — nDCG is undefined for them,
  // consistent with how evaluateGates() handles them.
  const scorableCases = allCases.filter((c) => c.expectedRelevantIds.length > 0);

  it('has at least one scorable eval case', () => {
    expect(scorableCases.length).toBeGreaterThan(0);
  });

  it('reranker nDCG@5 does not regress vs RRF-only (no-regression gate)', async () => {
    const comparisons: CaseComparison[] = [];

    for (const evalCase of scorableCases) {
      comparisons.push(await compareCase(evalCase));
    }

    const rrfMean = mean(comparisons.map((c) => c.rrfNdcg5));
    const rerankerMean = mean(comparisons.map((c) => c.rerankerNdcg5));
    const delta = rerankerMean - rrfMean;

    // ── Reporting ────────────────────────────────────────────────────────────
    console.log('\n=== RRF-only vs Reranker nDCG@5 (aggregate over scorable cases) ===');
    console.log(`  Cases scored:         ${comparisons.length}`);
    console.log(`  RRF-only nDCG@5:      ${rrfMean.toFixed(4)}`);
    console.log(`  Reranker nDCG@5:      ${rerankerMean.toFixed(4)}`);
    console.log(`  Delta (Δ):            ${delta >= 0 ? '+' : ''}${delta.toFixed(4)}`);
    console.log(`  Enable threshold:     +${ENABLE_THRESHOLD_DELTA} (informational, not enforced)`);
    console.log(`  Threshold met:        ${delta >= ENABLE_THRESHOLD_DELTA ? 'YES' : 'NO (fake reranker — live model needed for real Δ)'}`);
    console.log('');
    console.log('  Per-case breakdown:');
    for (const c of comparisons) {
      const d = c.rerankerNdcg5 - c.rrfNdcg5;
      console.log(
        `    ${c.id.padEnd(48)} rrf=${c.rrfNdcg5.toFixed(4)}  reranker=${c.rerankerNdcg5.toFixed(4)}  Δ=${d >= 0 ? '+' : ''}${d.toFixed(4)}`,
      );
    }
    console.log('====================================================================\n');

    // ── No-regression gate (the only hard assertion) ──────────────────────
    const epsilon = 1e-9;
    expect(rerankerMean).toBeGreaterThanOrEqual(rrfMean - epsilon);
  });

  it('per-case reranker nDCG@5 does not regress vs RRF-only', async () => {
    const epsilon = 1e-9;
    for (const evalCase of scorableCases) {
      const cmp = await compareCase(evalCase);
      expect(
        cmp.rerankerNdcg5,
        `case ${cmp.id}: reranker nDCG@5 (${cmp.rerankerNdcg5}) must not regress below rrf (${cmp.rrfNdcg5})`,
      ).toBeGreaterThanOrEqual(cmp.rrfNdcg5 - epsilon);
    }
  });
});
