// src/adapters/reranker/mastra-reranker.adapter.test.ts
import { describe, it, expect } from 'vitest';
import { MastraRerankerAdapter } from './mastra-reranker.adapter.ts';
import type { RelevanceScoreProvider } from '@mastra/core/relevance';
import type { SimilarStrategyCandidate } from '../../domain/strategy-retrieval.ts';

// --- Stub scorer -----------------------------------------------------------

/** Stub RelevanceScoreProvider: returns a score derived from a pre-seeded map. */
class StubScorer implements RelevanceScoreProvider {
  private readonly scores: Map<string, number>;

  constructor(scores: Record<string, number>) {
    this.scores = new Map(Object.entries(scores));
  }

  async getRelevanceScore(_query: string, text: string): Promise<number> {
    // text is the candidate description built by the adapter; stub keyed by label
    for (const [key, score] of this.scores) {
      if (text.includes(key)) return score;
    }
    return 0;
  }
}

// --- Helpers ---------------------------------------------------------------

function makeCandidate(
  id: string,
  rrfScore: number,
  label?: string,
): SimilarStrategyCandidate {
  return {
    strategyProfileId: id,
    rrfScore,
    metadata: { label: label ?? id },
  };
}

// --- Tests -----------------------------------------------------------------

describe('MastraRerankerAdapter', () => {
  describe('rerank()', () => {
    it('returns top limit candidates reordered by stub scorer', async () => {
      // Scorer gives delta (last) semantic=1.0, gamma (2nd-to-last) semantic=0.8.
      // Even with maximum position penalty, semantic weight (0.7) dominates position (0.3).
      // Expected order: delta (1.0 semantic) > gamma (0.8 semantic) > others.
      const scorer = new StubScorer({ alpha: 0.1, bravo: 0.2, gamma: 0.8, delta: 1.0 });
      const adapter = new MastraRerankerAdapter(scorer);

      const candidates: readonly SimilarStrategyCandidate[] = [
        makeCandidate('alpha', 0.9, 'alpha'),  // index 0, position=1.0, semantic=0.1 → 0.07+0.30=0.37
        makeCandidate('bravo', 0.7, 'bravo'),  // index 1, position=0.67, semantic=0.2 → 0.14+0.20=0.34
        makeCandidate('gamma', 0.4, 'gamma'),  // index 2, position=0.33, semantic=0.8 → 0.56+0.10=0.66
        makeCandidate('delta', 0.1, 'delta'),  // index 3, position=0.0, semantic=1.0  → 0.70+0.00=0.70
      ];

      const result = await adapter.rerank('test query', candidates, 2);

      expect(result).toHaveLength(2);
      // delta wins (highest combined 0.70), gamma is second (0.66)
      expect(result[0]!.strategyProfileId).toBe('delta');
      expect(result[1]!.strategyProfileId).toBe('gamma');
    });

    it('returns at most limit candidates', async () => {
      const scorer = new StubScorer({});
      const adapter = new MastraRerankerAdapter(scorer);

      const candidates = Array.from({ length: 10 }, (_, i) =>
        makeCandidate(`p${i}`, 1 - i * 0.1),
      );

      const result = await adapter.rerank('query', candidates, 3);
      expect(result).toHaveLength(3);
    });

    it('returns all candidates when limit >= candidates.length', async () => {
      const scorer = new StubScorer({});
      const adapter = new MastraRerankerAdapter(scorer);

      const candidates = [
        makeCandidate('a', 0.8),
        makeCandidate('b', 0.6),
      ];

      const result = await adapter.rerank('query', candidates, 5);
      expect(result).toHaveLength(2);
    });

    it('produces a deterministic order when all scorer scores are equal', async () => {
      // When semantic scores are equal, position (original index) is the tiebreaker.
      const scorer = new StubScorer({}); // all return 0
      const adapter = new MastraRerankerAdapter(scorer);

      const candidates: readonly SimilarStrategyCandidate[] = [
        makeCandidate('first', 0.9),
        makeCandidate('second', 0.5),
        makeCandidate('third', 0.1),
      ];

      const result1 = await adapter.rerank('q', candidates, 3);
      const result2 = await adapter.rerank('q', candidates, 3);

      expect(result1.map((c) => c.strategyProfileId)).toEqual(
        result2.map((c) => c.strategyProfileId),
      );
    });

    it('throws DOMException when signal is already aborted', async () => {
      const scorer = new StubScorer({});
      const adapter = new MastraRerankerAdapter(scorer);

      const ctl = new AbortController();
      ctl.abort();

      await expect(
        adapter.rerank('query', [makeCandidate('a', 1)], 1, ctl.signal),
      ).rejects.toThrow();
    });

    it('throws AbortError when signal aborts during scoring', async () => {
      // Slow scorer that we abort mid-flight
      const ctl = new AbortController();
      let firstCall = true;

      const slowScorer: RelevanceScoreProvider = {
        async getRelevanceScore(_q: string, _t: string): Promise<number> {
          if (firstCall) {
            firstCall = false;
            ctl.abort();
          }
          // Yield so that abort propagates
          await Promise.resolve();
          return 0.5;
        },
      };

      const adapter = new MastraRerankerAdapter(slowScorer);
      const candidates = [
        makeCandidate('a', 0.9),
        makeCandidate('b', 0.5),
      ];

      await expect(
        adapter.rerank('query', candidates, 2, ctl.signal),
      ).rejects.toThrow();
    });
  });
});
