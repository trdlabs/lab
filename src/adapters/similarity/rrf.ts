// src/adapters/similarity/rrf.ts

export interface RrfEntry {
  id: string;
  rank: number;
}

export interface RrfResult {
  id: string;
  score: number;
  lexicalRank?: number;
  vectorRank?: number;
}

export interface RrfSources {
  lexical: RrfEntry[];
  vector: RrfEntry[];
}

export interface RrfOptions {
  /** Smoothing constant — typical default is 60. */
  k: number;
  /** Maximum number of results to return. */
  limit: number;
}

/**
 * Reciprocal Rank Fusion over lexical and vector ranked lists.
 *
 * Score per document = Σ 1/(k + rank_i) across all lists that contain it.
 * Results are sorted by score DESC, then id ASC for equal scores (deterministic).
 *
 * Throws if duplicate ids appear within a single branch (caller bug).
 * The same id appearing in both branches is allowed and expected.
 */
export function reciprocalRankFusion(
  sources: RrfSources,
  opts: RrfOptions,
): RrfResult[] {
  const { k, limit } = opts;

  validateNoDuplicates('lexical', sources.lexical);
  validateNoDuplicates('vector', sources.vector);

  // Accumulate scores keyed by id.
  const acc = new Map<string, { score: number; lexicalRank?: number; vectorRank?: number }>();

  function accumulate(entries: RrfEntry[], rankKey: 'lexicalRank' | 'vectorRank'): void {
    for (const { id, rank } of entries) {
      const existing = acc.get(id) ?? { score: 0 };
      existing.score += 1 / (k + rank);
      existing[rankKey] = rank;
      acc.set(id, existing);
    }
  }

  accumulate(sources.lexical, 'lexicalRank');
  accumulate(sources.vector, 'vectorRank');

  const results: RrfResult[] = Array.from(acc.entries()).map(([id, v]) => ({
    id,
    score: v.score,
    ...(v.lexicalRank !== undefined ? { lexicalRank: v.lexicalRank } : {}),
    ...(v.vectorRank  !== undefined ? { vectorRank:  v.vectorRank  } : {}),
  }));

  // Sort: score DESC, then id ASC for tiebreak.
  results.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (scoreDiff !== 0) return scoreDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return results.slice(0, limit);
}

function validateNoDuplicates(branch: string, entries: RrfEntry[]): void {
  const seen = new Set<string>();
  for (const { id } of entries) {
    if (seen.has(id)) {
      throw new Error(
        `reciprocalRankFusion: duplicate id "${id}" within the "${branch}" branch`,
      );
    }
    seen.add(id);
  }
}
