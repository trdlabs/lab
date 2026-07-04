import type { HypothesisProposal, HypothesisStatus, HypothesisProxyMetrics } from '../../domain/hypothesis.ts';
import type { HypothesisProposalRepository } from '../../ports/hypothesis-proposal.repository.ts';

export class InMemoryHypothesisProposalRepository implements HypothesisProposalRepository {
  private readonly byId = new Map<string, HypothesisProposal>();

  async create(proposal: HypothesisProposal): Promise<void> {
    if (this.byId.has(proposal.id)) {
      throw new Error(`hypothesis_proposal already exists: ${proposal.id}`);
    }
    // Mirror the DB unique (strategy_profile_id, fingerprint) guard so both adapters behave
    // identically. The handler dedupes via `seen` before insert, so this is a race backstop.
    for (const p of this.byId.values()) {
      if (p.strategyProfileId === proposal.strategyProfileId && p.fingerprint === proposal.fingerprint) {
        throw new Error(
          `hypothesis_proposal already exists for fingerprint: ${proposal.fingerprint} (profile ${proposal.strategyProfileId})`,
        );
      }
    }
    this.byId.set(proposal.id, { ...proposal });
  }

  async findById(id: string): Promise<HypothesisProposal | null> {
    return this.byId.get(id) ?? null;
  }

  async listByStrategyProfile(strategyProfileId: string): Promise<HypothesisProposal[]> {
    return [...this.byId.values()].filter((h) => h.strategyProfileId === strategyProfileId);
  }

  async listFingerprints(strategyProfileId: string): Promise<string[]> {
    return [...this.byId.values()]
      .filter((h) => h.strategyProfileId === strategyProfileId)
      .map((h) => h.fingerprint);
  }

  async findLatestValidatedByProfile(strategyProfileId: string): Promise<HypothesisProposal | null> {
    const candidates = [...this.byId.values()]
      .filter((h) => h.strategyProfileId === strategyProfileId && h.status === 'validated')
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1; // createdAt DESC
        return a.id < b.id ? 1 : -1; // id DESC tiebreak
      });
    // Defensive copy — keep the store immutable from callers, matching findById.
    return candidates[0] ? { ...candidates[0] } : null;
  }

  async updateStatus(id: string, status: HypothesisStatus, proxyMetrics?: HypothesisProxyMetrics): Promise<void> {
    const existing = this.byId.get(id);
    if (!existing) {
      throw new Error(`hypothesis_proposal not found for id: ${id}`);
    }
    this.byId.set(id, {
      ...existing,
      status,
      ...(proxyMetrics !== undefined ? { proxyMetrics } : {}),
      updatedAt: new Date().toISOString(),
    });
  }
}
