// src/research/hypothesis-score.ts
//
// Pure, deterministic ordering for HypothesisProposal records. Consumed by the (future)
// revision.build handler for: merge order, conflict-winner selection, and picking the "worst"
// proposal to drop during greedy degradation (spec: docs/superpowers/specs/2026-07-03-strategy-revisions-design.md §4).
//
// No I/O. No imports beyond domain types.
import type { HypothesisProposal } from '../domain/hypothesis.ts';

export interface ScoredHypothesis {
  proposal: HypothesisProposal;
}

/**
 * Verdict rank for tier 1 of the comparator. Only PASS and PAPER_CANDIDATE are ever eligible
 * for a revision batch (see `sortEligible`'s status filter) — FAIL/MODIFY/INCONCLUSIVE and a
 * missing `proxyMetrics` are all unranked and fall back to 0 via the `?? 0` lookup below.
 */
export const VERDICT_RANK: Record<string, number> = { PAPER_CANDIDATE: 2, PASS: 1 };

const ELIGIBLE_STATUSES: ReadonlySet<HypothesisProposal['status']> = new Set([
  'proxy_passed',
  'proxy_paper_candidate',
]);

function verdictRank(p: HypothesisProposal): number {
  const decision = p.proxyMetrics?.decision;
  return decision === undefined ? 0 : (VERDICT_RANK[decision] ?? 0);
}

// Tier 2/3 "score" for each desc-sorted metric. A missing proxyMetrics is scored as -Infinity so
// it deterministically sorts last on both tiers, regardless of the actual sign of a real delta
// (including negative ones, which must still outrank "no signal at all").
const MISSING_METRIC_SCORE = Number.NEGATIVE_INFINITY;

function netPnlScore(p: HypothesisProposal): number {
  return p.proxyMetrics ? p.proxyMetrics.deltaNetPnlUsd : MISSING_METRIC_SCORE;
}

// Improvement = SMALLER deltaMaxDrawdownPct. We score it as the negated raw value so that
// sorting this score descending is equivalent to sorting the raw deltaMaxDrawdownPct ascending
// (smaller/better drawdown first), while still uniformly using the "-Infinity sorts last" idiom
// for a missing proxyMetrics.
function drawdownImprovementScore(p: HypothesisProposal): number {
  return p.proxyMetrics ? -p.proxyMetrics.deltaMaxDrawdownPct : MISSING_METRIC_SCORE;
}

/** Descending comparator over two scores that may be -Infinity; equal (incl. -Infinity vs
 *  -Infinity, which would otherwise subtract to NaN) compares as 0 so the tie falls through. */
function compareScoreDesc(a: number, b: number): number {
  if (a === b) return 0;
  return b - a;
}

/**
 * createdAt is a required string on HypothesisProposal, but records can still carry an empty or
 * unparseable ("unreliable", per spec §4) value. Both are treated as missing for tier 4 and
 * return null so the comparator can skip the tier entirely on either side, per spec.
 */
function parsedCreatedAt(p: HypothesisProposal): number | null {
  if (!p.createdAt) return null;
  const t = new Date(p.createdAt).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Lexicographic order (spec §4), most significant tier first:
 *   1. VERDICT_RANK[proxyMetrics.decision] desc (missing proxyMetrics / unranked decision -> 0)
 *   2. proxyMetrics.deltaNetPnlUsd desc (missing proxyMetrics -> -Infinity, sorts last)
 *   3. maxDrawdown improvement desc == deltaMaxDrawdownPct ascending, i.e. smaller/better delta
 *      wins (missing proxyMetrics -> -Infinity improvement score, sorts last)
 *   4. createdAt desc — SKIPPED entirely when createdAt is missing/unparseable on EITHER side
 *   5. id asc — final, always-decisive tie-break
 *
 * Negative: a sorts before b. Positive: b sorts before a. Zero: fully tied (identical proposal).
 */
export function compareHypotheses(a: HypothesisProposal, b: HypothesisProposal): number {
  const rankDiff = compareScoreDesc(verdictRank(a), verdictRank(b));
  if (rankDiff !== 0) return rankDiff;

  const pnlDiff = compareScoreDesc(netPnlScore(a), netPnlScore(b));
  if (pnlDiff !== 0) return pnlDiff;

  const drawdownDiff = compareScoreDesc(drawdownImprovementScore(a), drawdownImprovementScore(b));
  if (drawdownDiff !== 0) return drawdownDiff;

  const aCreated = parsedCreatedAt(a);
  const bCreated = parsedCreatedAt(b);
  if (aCreated !== null && bCreated !== null) {
    const createdDiff = compareScoreDesc(aCreated, bCreated);
    if (createdDiff !== 0) return createdDiff;
  }

  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Filters proposals to the revision-batch-eligible statuses FIRST (proxy_passed,
 * proxy_paper_candidate — everything else, including validated/proxy_failed, is excluded), then
 * sorts the survivors by `compareHypotheses`.
 */
export function sortEligible(proposals: HypothesisProposal[]): HypothesisProposal[] {
  return proposals.filter((p) => ELIGIBLE_STATUSES.has(p.status)).sort(compareHypotheses);
}
