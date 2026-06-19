import type { HypothesisProposal } from '../../domain/hypothesis.ts';
import type { HypothesisReadPort, HypothesisListQuery } from '../../ports/hypothesis-read.port.ts';

function cmpDesc(a: HypothesisProposal, b: HypothesisProposal): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

export class InMemoryHypothesisReadAdapter implements HypothesisReadPort {
  private readonly seed: HypothesisProposal[];

  constructor(seed: HypothesisProposal[] = []) {
    this.seed = seed;
  }

  async list(q: HypothesisListQuery): Promise<HypothesisProposal[]> {
    let rows = [...this.seed];
    if (q.status) rows = rows.filter((h) => h.status === q.status);
    if (q.profileId) rows = rows.filter((h) => h.strategyProfileId === q.profileId);
    rows.sort(cmpDesc);
    if (q.after) {
      const { t, id } = q.after;
      rows = rows.filter((h) => h.createdAt < t || (h.createdAt === t && h.id < id));
    }
    return rows.slice(0, q.limit);
  }

  async getById(id: string): Promise<HypothesisProposal | null> {
    return this.seed.find((h) => h.id === id) ?? null;
  }
}
