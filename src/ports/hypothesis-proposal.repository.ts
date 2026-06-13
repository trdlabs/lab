import type { HypothesisProposal } from '../domain/hypothesis.ts';

export interface HypothesisProposalRepository {
  create(proposal: HypothesisProposal): Promise<void>;
  findById(id: string): Promise<HypothesisProposal | null>;
  listByStrategyProfile(strategyProfileId: string): Promise<HypothesisProposal[]>;
  listFingerprints(strategyProfileId: string): Promise<string[]>;
  /**
   * Latest VALIDATED proposal for a resolved profile (session-scoped, not global).
   * Deterministic order: createdAt DESC, id DESC. "Latest", not "best" — ranking is
   * out of scope. Canonical source of truth for hypothesis existence stays here.
   */
  findLatestValidatedByProfile(strategyProfileId: string): Promise<HypothesisProposal | null>;
}
