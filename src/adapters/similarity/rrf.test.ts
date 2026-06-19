// src/adapters/similarity/rrf.test.ts
import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion } from './rrf.ts';

describe('reciprocalRankFusion', () => {
  it('fuses lexical and vector ranks with deterministic id tiebreak', () => {
    const result = reciprocalRankFusion(
      {
        lexical: [{ id: 'a', rank: 1 }, { id: 'b', rank: 2 }],
        vector:  [{ id: 'b', rank: 1 }, { id: 'c', rank: 2 }],
      },
      { k: 60, limit: 20 },
    );
    expect(result.map((x) => x.id)).toEqual(['b', 'a', 'c']);
    // b: 1/(60+2) + 1/(60+1) = 1/62 + 1/61
    expect(result[0]!.score).toBeCloseTo(1 / 62 + 1 / 61);
  });

  it('returns only lexical entries when vector branch is empty', () => {
    const result = reciprocalRankFusion(
      {
        lexical: [{ id: 'x', rank: 1 }, { id: 'y', rank: 2 }],
        vector:  [],
      },
      { k: 60, limit: 20 },
    );
    expect(result.map((x) => x.id)).toEqual(['x', 'y']);
    expect(result[0]!.lexicalRank).toBe(1);
    expect(result[0]!.vectorRank).toBeUndefined();
  });

  it('returns only vector entries when lexical branch is empty', () => {
    const result = reciprocalRankFusion(
      {
        lexical: [],
        vector:  [{ id: 'm', rank: 1 }, { id: 'n', rank: 2 }],
      },
      { k: 60, limit: 20 },
    );
    expect(result.map((x) => x.id)).toEqual(['m', 'n']);
    expect(result[0]!.vectorRank).toBe(1);
    expect(result[0]!.lexicalRank).toBeUndefined();
  });

  it('returns empty array when both branches are empty', () => {
    const result = reciprocalRankFusion(
      { lexical: [], vector: [] },
      { k: 60, limit: 20 },
    );
    expect(result).toEqual([]);
  });

  it('throws when lexical branch contains duplicate ids', () => {
    expect(() =>
      reciprocalRankFusion(
        {
          lexical: [{ id: 'a', rank: 1 }, { id: 'a', rank: 2 }],
          vector:  [],
        },
        { k: 60, limit: 20 },
      ),
    ).toThrow();
  });

  it('throws when vector branch contains duplicate ids', () => {
    expect(() =>
      reciprocalRankFusion(
        {
          lexical: [],
          vector:  [{ id: 'z', rank: 1 }, { id: 'z', rank: 2 }],
        },
        { k: 60, limit: 20 },
      ),
    ).toThrow();
  });

  it('does not throw when the same id appears in both branches', () => {
    expect(() =>
      reciprocalRankFusion(
        {
          lexical: [{ id: 'shared', rank: 1 }],
          vector:  [{ id: 'shared', rank: 1 }],
        },
        { k: 60, limit: 20 },
      ),
    ).not.toThrow();
  });

  it('enforces limit on result length', () => {
    const lexical = Array.from({ length: 10 }, (_, i) => ({ id: `l${i}`, rank: i + 1 }));
    const vector  = Array.from({ length: 10 }, (_, i) => ({ id: `v${i}`, rank: i + 1 }));
    const result = reciprocalRankFusion({ lexical, vector }, { k: 60, limit: 5 });
    expect(result.length).toBe(5);
  });

  it('uses stable id-ascending order for equal scores', () => {
    // Two entries that each appear in only one branch at the same rank get equal scores.
    // 'a' < 'z' lexicographically — 'a' must come first.
    const result = reciprocalRankFusion(
      {
        lexical: [{ id: 'z', rank: 1 }],
        vector:  [{ id: 'a', rank: 1 }],
      },
      { k: 60, limit: 20 },
    );
    expect(result.map((x) => x.id)).toEqual(['a', 'z']);
  });

  it('preserves lexicalRank and vectorRank in output entries', () => {
    const result = reciprocalRankFusion(
      {
        lexical: [{ id: 'p', rank: 3 }],
        vector:  [{ id: 'p', rank: 7 }],
      },
      { k: 60, limit: 20 },
    );
    expect(result[0]!.id).toBe('p');
    expect(result[0]!.lexicalRank).toBe(3);
    expect(result[0]!.vectorRank).toBe(7);
  });
});
