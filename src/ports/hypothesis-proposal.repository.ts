import type { HypothesisProposal, HypothesisStatus, HypothesisProxyMetrics } from '../domain/hypothesis.ts';

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
  /** Updates status (+ optional proxyMetrics). Throws, naming the id, when it doesn't exist. */
  updateStatus(id: string, status: HypothesisStatus, proxyMetrics?: HypothesisProxyMetrics): Promise<void>;
}
