import { and, asc, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { strategyRevision } from '../../db/schema.ts';
import type { StrategyRevision } from '../../domain/strategy-revision.ts';
import type { StrategyRevisionRepository } from '../../ports/strategy-revision.repository.ts';

export type StrategyRevisionRow = typeof strategyRevision.$inferSelect;

// Exported so other adapters can reuse the SAME mapper — single source of truth.
export function strategyRevisionToDomain(r: StrategyRevisionRow): StrategyRevision {
  return {
    id: r.id, strategyProfileId: r.strategyProfileId, version: r.version,
    baseRevisionId: r.baseRevisionId ?? undefined,
    hypothesisIds: r.hypothesisIds,
    dropped: r.dropped ?? undefined,
    mergedRuleSet: r.mergedRuleSet,
    bundleArtifactRef: r.bundleArtifactRef ?? undefined,
    bundleHash: r.bundleHash ?? undefined,
    comboBacktestRunId: r.comboBacktestRunId ?? undefined,
    status: r.status,
    metrics: r.metrics ?? undefined,
    verdictReason: r.verdictReason ?? undefined,
    preservationGate: r.preservationGate ?? undefined,
    holdoutValidation: r.holdoutValidation ?? undefined,
    selectionEvaluation: r.selectionEvaluation ?? undefined,
    kind: r.kind ?? 'composed',
    consolidatedFromRevisionId: r.consolidatedFromRevisionId ?? undefined,
    semanticParentRevisionId: r.semanticParentRevisionId ?? undefined,
    compositionDepth: r.compositionDepth ?? 1,
    baselineValidationStatus: r.baselineValidationStatus ?? undefined,
    baselineExperimentId: r.baselineExperimentId ?? undefined,
    baselineTaskId: r.baselineTaskId ?? undefined,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}

export class DrizzleStrategyRevisionRepository implements StrategyRevisionRepository {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  async create(r: StrategyRevision): Promise<void> {
    await this.db.insert(strategyRevision).values({
      id: r.id, strategyProfileId: r.strategyProfileId, version: r.version,
      baseRevisionId: r.baseRevisionId ?? null,
      hypothesisIds: r.hypothesisIds,
      dropped: r.dropped ?? null,
      mergedRuleSet: r.mergedRuleSet,
      bundleArtifactRef: r.bundleArtifactRef ?? null,
      bundleHash: r.bundleHash ?? null,
      comboBacktestRunId: r.comboBacktestRunId ?? null,
      status: r.status,
      metrics: r.metrics ?? null,
      verdictReason: r.verdictReason ?? null,
      holdoutValidation: r.holdoutValidation ?? null,
      selectionEvaluation: r.selectionEvaluation ?? null,
      kind: r.kind ?? 'composed',
      consolidatedFromRevisionId: r.consolidatedFromRevisionId ?? null,
      semanticParentRevisionId: r.semanticParentRevisionId ?? null,
      compositionDepth: r.compositionDepth ?? 1,
      baselineValidationStatus: r.baselineValidationStatus ?? null,
      baselineExperimentId: r.baselineExperimentId ?? null,
      baselineTaskId: r.baselineTaskId ?? null,
      createdAt: new Date(r.createdAt), updatedAt: new Date(r.updatedAt),
    });
  }

  async findById(id: string): Promise<StrategyRevision | null> {
    const rows = await this.db.select().from(strategyRevision).where(eq(strategyRevision.id, id)).limit(1);
    return rows[0] ? strategyRevisionToDomain(rows[0]) : null;
  }

  async findLatestAccepted(strategyProfileId: string): Promise<StrategyRevision | null> {
    const rows = await this.db.select().from(strategyRevision)
      .where(and(eq(strategyRevision.strategyProfileId, strategyProfileId), eq(strategyRevision.status, 'accepted')))
      .orderBy(desc(strategyRevision.version))
      .limit(1);
    return rows[0] ? strategyRevisionToDomain(rows[0]) : null;
  }

  async findMaxVersion(strategyProfileId: string): Promise<number> {
    // Max version across ALL statuses — see the port comment: collision-free version allocation.
    const rows = await this.db.select({ version: strategyRevision.version }).from(strategyRevision)
      .where(eq(strategyRevision.strategyProfileId, strategyProfileId))
      .orderBy(desc(strategyRevision.version))
      .limit(1);
    return rows[0]?.version ?? 0;
  }

  async updateStatus(id: string, patch: Partial<Pick<StrategyRevision,
    'status' | 'comboBacktestRunId' | 'metrics' | 'verdictReason' | 'preservationGate' | 'holdoutValidation' | 'selectionEvaluation' | 'dropped' | 'hypothesisIds' | 'mergedRuleSet' | 'bundleArtifactRef' | 'bundleHash' | 'updatedAt' | 'baselineValidationStatus' | 'baselineExperimentId' | 'baselineTaskId'>>): Promise<void> {
    const set: Record<string, unknown> = {};
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.comboBacktestRunId !== undefined) set.comboBacktestRunId = patch.comboBacktestRunId;
    if (patch.metrics !== undefined) set.metrics = patch.metrics;
    if (patch.verdictReason !== undefined) set.verdictReason = patch.verdictReason;
    if (patch.preservationGate !== undefined) set.preservationGate = patch.preservationGate;
    if (patch.holdoutValidation !== undefined) set.holdoutValidation = patch.holdoutValidation;
    if (patch.selectionEvaluation !== undefined) set.selectionEvaluation = patch.selectionEvaluation;
    if (patch.dropped !== undefined) set.dropped = patch.dropped;
    if (patch.hypothesisIds !== undefined) set.hypothesisIds = patch.hypothesisIds;
    if (patch.mergedRuleSet !== undefined) set.mergedRuleSet = patch.mergedRuleSet;
    if (patch.bundleArtifactRef !== undefined) set.bundleArtifactRef = patch.bundleArtifactRef;
    if (patch.bundleHash !== undefined) set.bundleHash = patch.bundleHash;
    if (patch.updatedAt !== undefined) set.updatedAt = new Date(patch.updatedAt);
    if (patch.baselineValidationStatus !== undefined) set.baselineValidationStatus = patch.baselineValidationStatus;
    if (patch.baselineExperimentId !== undefined) set.baselineExperimentId = patch.baselineExperimentId;
    if (patch.baselineTaskId !== undefined) set.baselineTaskId = patch.baselineTaskId;

    const result = await this.db.update(strategyRevision).set(set).where(eq(strategyRevision.id, id)).returning({ id: strategyRevision.id });
    if (result.length === 0) throw new Error(`strategy revision not found for id: ${id}`);
  }

  async listByProfile(strategyProfileId: string): Promise<StrategyRevision[]> {
    const rows = await this.db.select().from(strategyRevision)
      .where(eq(strategyRevision.strategyProfileId, strategyProfileId))
      .orderBy(asc(strategyRevision.version));
    return rows.map(strategyRevisionToDomain);
  }

  async findConsolidatedOf(revisionId: string): Promise<StrategyRevision | null> {
    const rows = await this.db.select().from(strategyRevision)
      .where(and(eq(strategyRevision.consolidatedFromRevisionId, revisionId), eq(strategyRevision.kind, 'consolidated')))
      .limit(1);
    return rows[0] ? strategyRevisionToDomain(rows[0]) : null;
  }
}
