import type { StrategyRevision } from '../../domain/strategy-revision.ts';
import type { StrategyRevisionRepository } from '../../ports/strategy-revision.repository.ts';

export class InMemoryStrategyRevisionRepository implements StrategyRevisionRepository {
  private readonly byId = new Map<string, StrategyRevision>();

  async create(r: StrategyRevision): Promise<void> {
    const dup = [...this.byId.values()].some(
      (x) => x.strategyProfileId === r.strategyProfileId && x.version === r.version,
    );
    if (dup) {
      throw new Error(`strategy revision already exists for strategyProfileId ${r.strategyProfileId} version ${r.version}`);
    }
    this.byId.set(r.id, { ...r });
  }

  async findById(id: string): Promise<StrategyRevision | null> {
    return this.byId.get(id) ?? null;
  }

  async findLatestAccepted(strategyProfileId: string): Promise<StrategyRevision | null> {
    const accepted = [...this.byId.values()].filter(
      (r) => r.strategyProfileId === strategyProfileId && r.status === 'accepted',
    );
    if (accepted.length === 0) return null;
    return accepted.reduce((max, r) => (r.version > max.version ? r : max));
  }

  async findMaxVersion(strategyProfileId: string): Promise<number> {
    let max = 0;
    for (const r of this.byId.values()) {
      if (r.strategyProfileId === strategyProfileId && r.version > max) max = r.version;
    }
    return max;
  }

  async updateStatus(id: string, patch: Partial<Pick<StrategyRevision,
    'status' | 'comboBacktestRunId' | 'metrics' | 'verdictReason' | 'dropped' | 'hypothesisIds' | 'mergedRuleSet' | 'bundleArtifactRef' | 'bundleHash' | 'updatedAt' | 'baselineValidationStatus' | 'baselineExperimentId' | 'baselineTaskId' | 'preservationGate'>>): Promise<void> {
    const existing = this.byId.get(id);
    if (!existing) throw new Error(`strategy revision not found for id: ${id}`);
    const next: StrategyRevision = { ...existing };
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.comboBacktestRunId !== undefined) next.comboBacktestRunId = patch.comboBacktestRunId;
    if (patch.metrics !== undefined) next.metrics = patch.metrics;
    if (patch.verdictReason !== undefined) next.verdictReason = patch.verdictReason;
    if (patch.dropped !== undefined) next.dropped = patch.dropped;
    if (patch.hypothesisIds !== undefined) next.hypothesisIds = patch.hypothesisIds;
    if (patch.mergedRuleSet !== undefined) next.mergedRuleSet = patch.mergedRuleSet;
    if (patch.bundleArtifactRef !== undefined) next.bundleArtifactRef = patch.bundleArtifactRef;
    if (patch.bundleHash !== undefined) next.bundleHash = patch.bundleHash;
    if (patch.updatedAt !== undefined) next.updatedAt = patch.updatedAt;
    if (patch.baselineValidationStatus !== undefined) next.baselineValidationStatus = patch.baselineValidationStatus;
    if (patch.baselineExperimentId !== undefined) next.baselineExperimentId = patch.baselineExperimentId;
    if (patch.baselineTaskId !== undefined) next.baselineTaskId = patch.baselineTaskId;
    if (patch.preservationGate !== undefined) next.preservationGate = patch.preservationGate;
    this.byId.set(id, next);
  }

  async listByProfile(strategyProfileId: string): Promise<StrategyRevision[]> {
    return [...this.byId.values()]
      .filter((r) => r.strategyProfileId === strategyProfileId)
      .sort((a, b) => a.version - b.version);
  }

  async findConsolidatedOf(revisionId: string): Promise<StrategyRevision | null> {
    const found = [...this.byId.values()].find(
      (r) => r.kind === 'consolidated' && r.consolidatedFromRevisionId === revisionId,
    );
    return found ?? null;
  }
}
