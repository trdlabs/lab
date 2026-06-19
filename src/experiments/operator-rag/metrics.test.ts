// src/experiments/operator-rag/metrics.test.ts
// TDD: hand-calculated expected values with arithmetic shown in comments.
import { describe, it, expect } from 'vitest';
import { recallAtK, reciprocalRank, ndcgAtK, mean, round } from './metrics.ts';

// ─── recallAtK ────────────────────────────────────────────────────────────────

describe('recallAtK', () => {
  it('returns 0 for empty relevantIds (no division by zero / NaN)', () => {
    // |relevant| = 0 → return 0 by convention
    expect(recallAtK(['a', 'b', 'c'], [], 5)).toBe(0);
  });

  it('returns 0 for empty retrievedIds', () => {
    // hits = 0, |relevant| = 2 → 0/2 = 0
    expect(recallAtK([], ['a', 'b'], 5)).toBe(0);
  });

  it('perfect recall when all relevant docs are in top-k', () => {
    // retrieved = [a, b, c], relevant = [a, b], k = 5
    // hits in top-5 = {a, b} → 2, |relevant| = 2 → 2/2 = 1.0
    expect(recallAtK(['a', 'b', 'c'], ['a', 'b'], 5)).toBe(1.0);
  });

  it('partial recall: 1 of 3 relevant found in top-3', () => {
    // retrieved = [x, a, y, b, c], k = 3 → top-3 = [x, a, y]
    // relevant = {a, b, c}, hits = {a} = 1
    // recall = 1 / 3 ≈ 0.333333
    expect(recallAtK(['x', 'a', 'y', 'b', 'c'], ['a', 'b', 'c'], 3)).toBe(round(1 / 3));
  });

  it('recall = 0 when no relevant doc appears in top-k', () => {
    // retrieved = [x, y], k = 2, relevant = [a, b]
    // hits = 0 → 0 / 2 = 0
    expect(recallAtK(['x', 'y', 'a'], ['a', 'b'], 2)).toBe(0);
  });

  it('recall = 2/3 when 2 of 3 relevant are in top-5', () => {
    // retrieved = [a, x, b, y, z], k = 5
    // relevant = {a, b, c}, hits in top-5 = {a, b} = 2
    // recall = 2 / 3 ≈ 0.666667
    expect(recallAtK(['a', 'x', 'b', 'y', 'z'], ['a', 'b', 'c'], 5)).toBe(round(2 / 3));
  });

  it('k larger than retrieved list: uses all retrieved', () => {
    // retrieved = [a, b], relevant = [a, b, c], k = 100
    // top-100 → [a, b], hits = 2, |relevant| = 3
    // recall = 2/3 ≈ 0.666667
    expect(recallAtK(['a', 'b'], ['a', 'b', 'c'], 100)).toBe(round(2 / 3));
  });

  it('recall@1: only top result matters', () => {
    // retrieved = [a, b, c], relevant = [b, c], k = 1 → top-1 = [a]
    // hits = 0 → 0 / 2 = 0
    expect(recallAtK(['a', 'b', 'c'], ['b', 'c'], 1)).toBe(0);
  });

  it('recall@1 hit: top result is relevant', () => {
    // retrieved = [b, a, c], relevant = [b, c], k = 1 → top-1 = [b]
    // hits = 1 → 1 / 2 = 0.5
    expect(recallAtK(['b', 'a', 'c'], ['b', 'c'], 1)).toBe(0.5);
  });
});

// ─── reciprocalRank ───────────────────────────────────────────────────────────

describe('reciprocalRank', () => {
  it('returns 0 for empty relevantIds', () => {
    // No relevant docs → RR = 0
    expect(reciprocalRank(['a', 'b', 'c'], [])).toBe(0);
  });

  it('returns 0 for empty retrievedIds', () => {
    // No retrieved docs → cannot find any relevant → RR = 0
    expect(reciprocalRank([], ['a'])).toBe(0);
  });

  it('RR = 1 when first result is relevant (rank 1)', () => {
    // First result 'a' is relevant → rank = 1 → RR = 1/1 = 1.0
    expect(reciprocalRank(['a', 'b', 'c'], ['a'])).toBe(1.0);
  });

  it('RR = 0.5 when relevant is at rank 2', () => {
    // retrieved = [x, a, b], relevant = {a}
    // First relevant at index 1 → rank 2 → RR = 1/2 = 0.5
    expect(reciprocalRank(['x', 'a', 'b'], ['a'])).toBe(0.5);
  });

  it('RR = 1/3 when relevant is at rank 3', () => {
    // retrieved = [x, y, a], relevant = {a}
    // First relevant at index 2 → rank 3 → RR = 1/3 ≈ 0.333333
    expect(reciprocalRank(['x', 'y', 'a'], ['a'])).toBe(round(1 / 3));
  });

  it('RR = 1/4 when relevant is at rank 4', () => {
    // retrieved = [x, y, z, a], relevant = {a}
    // First relevant at index 3 → rank 4 → RR = 1/4 = 0.25
    expect(reciprocalRank(['x', 'y', 'z', 'a'], ['a'])).toBe(0.25);
  });

  it('returns 0 when no relevant appears in retrieved', () => {
    // retrieved = [x, y, z], relevant = {a, b}
    // None found → RR = 0
    expect(reciprocalRank(['x', 'y', 'z'], ['a', 'b'])).toBe(0);
  });

  it('returns rank of FIRST relevant when multiple relevant exist', () => {
    // retrieved = [x, a, b], relevant = {a, b}
    // First relevant at index 1 (rank 2) → RR = 1/2 = 0.5
    // (b at rank 3 does NOT count; only the first one matters)
    expect(reciprocalRank(['x', 'a', 'b'], ['a', 'b'])).toBe(0.5);
  });
});

// ─── ndcgAtK ─────────────────────────────────────────────────────────────────
//
// DCG formula: sum_{i=1}^{k} (2^grade_i - 1) / log2(i+1), where i is 1-based rank.
// IDCG: same but with grades sorted descending over all relevant items.
// nDCG = DCG / IDCG.
//
// log2(2) = 1, log2(3) ≈ 1.58496, log2(4) ≈ 2, log2(5) ≈ 2.32193

describe('ndcgAtK', () => {
  it('returns 0 for empty gradedRelevance (IDCG = 0)', () => {
    // No graded docs → IDCG = 0 → nDCG = 0 (not NaN)
    expect(ndcgAtK(['a', 'b', 'c'], {}, 5)).toBe(0);
  });

  it('returns 0 for empty retrievedIds', () => {
    // DCG = 0, IDCG > 0 → nDCG = 0
    expect(ndcgAtK([], { a: 3, b: 2 }, 5)).toBe(0);
  });

  it('nDCG = 1.0 for perfect ranking (grade 3 at rank 1, grade 2 at rank 2)', () => {
    // retrieved = [a, b], grades = {a:3, b:2}, k = 2
    // DCG = (2^3-1)/log2(2) + (2^2-1)/log2(3)
    //     = 7/1         + 3/1.58496
    //     = 7           + 1.89278
    //     = 8.89278
    //
    // IDCG: sorted grades = [3,2] (ideal order = same)
    //     = (2^3-1)/log2(2) + (2^2-1)/log2(3)
    //     = 8.89278
    //
    // nDCG = 8.89278 / 8.89278 = 1.0
    expect(ndcgAtK(['a', 'b'], { a: 3, b: 2 }, 2)).toBe(1.0);
  });

  it('nDCG < 1.0 when retrieval order is suboptimal', () => {
    // retrieved = [b, a], grades = {a:3, b:2}, k = 2
    // DCG = (2^2-1)/log2(2) + (2^3-1)/log2(3)
    //     = 3/1         + 7/1.58496
    //     = 3           + 4.41611
    //     = 7.41611
    //
    // IDCG = (2^3-1)/log2(2) + (2^2-1)/log2(3)
    //      = 7 + 1.89278 = 8.89278
    //
    // nDCG = 7.41611 / 8.89278 ≈ 0.83398
    const result = ndcgAtK(['b', 'a'], { a: 3, b: 2 }, 2);
    expect(result).toBeGreaterThan(0.8);
    expect(result).toBeLessThan(1.0);
    // Exact: 7.41611 / 8.89278
    const dcgVal = 3 / Math.log2(2) + 7 / Math.log2(3);
    const idcgVal = 7 / Math.log2(2) + 3 / Math.log2(3);
    expect(result).toBe(round(dcgVal / idcgVal));
  });

  it('nDCG = 0 when top-k contains no relevant docs', () => {
    // retrieved = [x, y], grades = {a:3}, k = 2
    // DCG = 0 (x and y have grade 0)
    // IDCG = (2^3-1)/log2(2) = 7
    // nDCG = 0 / 7 = 0
    expect(ndcgAtK(['x', 'y'], { a: 3 }, 2)).toBe(0);
  });

  it('nDCG@5 with only grade-0 entries in gradedRelevance returns 0', () => {
    // All grades are 0 → IDCG = 0 → return 0
    expect(ndcgAtK(['a', 'b'], { a: 0, b: 0 }, 5)).toBe(0);
  });

  it('nDCG@1 = 1.0 when rank-1 is the highest-grade doc', () => {
    // retrieved = [a, b, c], grades = {a:3, b:2, c:1}, k = 1
    // DCG@1 = (2^3-1)/log2(2) = 7/1 = 7
    // IDCG@1: best grade is 3 → (2^3-1)/log2(2) = 7
    // nDCG = 7/7 = 1.0
    expect(ndcgAtK(['a', 'b', 'c'], { a: 3, b: 2, c: 1 }, 1)).toBe(1.0);
  });

  it('nDCG@1 < 1.0 when rank-1 is not the best doc', () => {
    // retrieved = [b, a, c], grades = {a:3, b:2, c:1}, k = 1
    // DCG@1 = (2^2-1)/log2(2) = 3/1 = 3
    // IDCG@1 = (2^3-1)/log2(2) = 7/1 = 7
    // nDCG = 3/7 ≈ 0.428571
    expect(ndcgAtK(['b', 'a', 'c'], { a: 3, b: 2, c: 1 }, 1)).toBe(round(3 / 7));
  });

  it('nDCG with single grade-1 doc at rank 1', () => {
    // retrieved = [a], grades = {a:1}, k = 5
    // DCG = (2^1-1)/log2(2) = 1/1 = 1
    // IDCG = same = 1
    // nDCG = 1.0
    expect(ndcgAtK(['a'], { a: 1 }, 5)).toBe(1.0);
  });

  it('nDCG@5 with 3 relevant docs at ranks 1, 3, 5', () => {
    // retrieved = [a, x, b, y, c], grades = {a:3, b:2, c:1}, k=5
    // DCG = (2^3-1)/log2(2) + 0/log2(3) + (2^2-1)/log2(4) + 0/log2(5) + (2^1-1)/log2(6)
    //     = 7/1 + 0 + 3/2 + 0 + 1/log2(6)
    //     = 7 + 1.5 + 1/2.58496
    //     = 7 + 1.5 + 0.38685
    //     = 8.88685
    //
    // IDCG@5: sorted grades [3,2,1] at ranks 1,2,3
    //     = 7/1 + 3/log2(3) + 1/log2(4)
    //     = 7 + 3/1.58496 + 1/2
    //     = 7 + 1.89278 + 0.5
    //     = 9.39278
    //
    // nDCG = 8.88685 / 9.39278 ≈ 0.94617
    const retrieved = ['a', 'x', 'b', 'y', 'c'];
    const grades: Record<string, 0 | 1 | 2 | 3> = { a: 3, b: 2, c: 1, x: 0, y: 0 };
    const dcgVal = 7 / Math.log2(2) + 3 / Math.log2(4) + 1 / Math.log2(6);
    const idcgVal = 7 / Math.log2(2) + 3 / Math.log2(3) + 1 / Math.log2(4);
    const expected = round(dcgVal / idcgVal);
    expect(ndcgAtK(retrieved, grades, 5)).toBe(expected);
  });
});

// ─── mean ─────────────────────────────────────────────────────────────────────

describe('mean', () => {
  it('returns 0 for empty array', () => {
    expect(mean([])).toBe(0);
  });

  it('returns the value for a single-element array', () => {
    expect(mean([0.75])).toBe(0.75);
  });

  it('computes mean correctly', () => {
    // (1 + 0.5 + 0.25) / 3 = 1.75 / 3 ≈ 0.583333
    expect(mean([1, 0.5, 0.25])).toBe(round((1 + 0.5 + 0.25) / 3));
  });
});

// ─── round ────────────────────────────────────────────────────────────────────

describe('round', () => {
  it('rounds to 6 decimals by default', () => {
    expect(round(1 / 3)).toBe(0.333333);
  });

  it('rounds to specified decimals', () => {
    expect(round(1 / 3, 2)).toBe(0.33);
  });
});
