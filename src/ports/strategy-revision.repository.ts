import type { StrategyRevision } from '../domain/strategy-revision.ts';

export interface StrategyRevisionRepository {
  create(r: StrategyRevision): Promise<void>;
  findById(id: string): Promise<StrategyRevision | null>;
  // Max version among status === 'accepted' rows for the profile.
  findLatestAccepted(strategyProfileId: string): Promise<StrategyRevision | null>;
  // Patches only the named fields (defined keys only); throws with the id in the
  // message when no row exists for it.
  updateStatus(id: string, patch: Partial<Pick<StrategyRevision,
    'status' | 'comboBacktestRunId' | 'metrics' | 'verdictReason' | 'dropped' | 'hypothesisIds' | 'mergedRuleSet' | 'bundleArtifactRef' | 'bundleHash' | 'updatedAt'>>): Promise<void>;
  listByProfile(strategyProfileId: string): Promise<StrategyRevision[]>; // version asc
}
