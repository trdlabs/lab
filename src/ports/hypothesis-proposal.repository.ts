import type { HypothesisProposal } from '../domain/hypothesis.ts';

export interface HypothesisProposalRepository {
  create(proposal: HypothesisProposal): Promise<void>;
  findById(id: string): Promise<HypothesisProposal | null>;
  listByStrategyProfile(strategyProfileId: string): Promise<HypothesisProposal[]>;
  listFingerprints(strategyProfileId: string): Promise<string[]>;
}
