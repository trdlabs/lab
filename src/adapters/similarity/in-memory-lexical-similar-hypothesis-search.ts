import type { SimilarHypothesisSummary } from '../../domain/hypothesis.ts';
import type { HypothesisProposalRepository } from '../../ports/hypothesis-proposal.repository.ts';
import type { SimilarHypothesisSearchPort } from '../../ports/similar-hypothesis-search.port.ts';

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export class InMemoryLexicalSimilarHypothesisSearch implements SimilarHypothesisSearchPort {
  private readonly repo: HypothesisProposalRepository;
  constructor(repo: HypothesisProposalRepository) {
    this.repo = repo;
  }

  async search(strategyProfileId: string, query: string, limit: number): Promise<SimilarHypothesisSummary[]> {
    const all = await this.repo.listByStrategyProfile(strategyProfileId);
    const queryTokens = tokenize(query);
    const scored = all.map((h) => ({
      hypothesisId: h.id,
      thesis: h.thesis,
      status: h.status,
      score: jaccard(queryTokens, tokenize(h.thesis)),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}
