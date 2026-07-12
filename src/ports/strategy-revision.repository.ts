import type { StrategyRevision } from '../domain/strategy-revision.ts';

export interface StrategyRevisionRepository {
  create(r: StrategyRevision): Promise<void>;
  findById(id: string): Promise<StrategyRevision | null>;
  // Max version among status === 'accepted' rows for the profile.
  findLatestAccepted(strategyProfileId: string): Promise<StrategyRevision | null>;
  // Max version across ALL statuses for the profile (0 when none). Version allocation must use this,
  // not accepted.version + 1: a rejected or stranded-candidate row occupies a version number, so
  // reusing accepted.version + 1 collides on UNIQUE(profileId, version) and wedges the lane (P0-3).
  findMaxVersion(strategyProfileId: string): Promise<number>;
  // Patches only the named fields (defined keys only); throws with the id in the
  // message when no row exists for it.
  updateStatus(id: string, patch: Partial<Pick<StrategyRevision,
    'status' | 'comboBacktestRunId' | 'metrics' | 'verdictReason' | 'preservationGate' | 'dropped' | 'hypothesisIds' | 'mergedRuleSet' | 'bundleArtifactRef' | 'bundleHash' | 'updatedAt' | 'baselineValidationStatus' | 'baselineExperimentId' | 'baselineTaskId'>>): Promise<void>;
  listByProfile(strategyProfileId: string): Promise<StrategyRevision[]>; // version asc
  /** The consolidated revision that materializes `revisionId` (kind='consolidated', consolidatedFromRevisionId=revisionId), or null. */
  findConsolidatedOf(revisionId: string): Promise<StrategyRevision | null>;
}
