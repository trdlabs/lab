import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { researchExperiment, experimentRunMember, experimentEvaluation } from '../../db/schema.ts';
import type {
  ResearchExperiment, ExperimentRunMember, ExperimentEvaluation,
} from '../../domain/research-experiment.ts';
import type { ResearchExperimentRepository } from '../../ports/research-experiment.repository.ts';

export type ExpRow = typeof researchExperiment.$inferSelect;
export type MemRow = typeof experimentRunMember.$inferSelect;

// Exported so the read adapter (Task 4) reuses the SAME mappers — single source of truth.
export function expToDomain(r: ExpRow): ResearchExperiment {
  return {
    id: r.id, experimentKey: r.experimentKey, experimentType: r.experimentType,
    strategyProfileId: r.strategyProfileId,
    hypothesisId: r.hypothesisId ?? undefined, buildId: r.buildId ?? undefined,
    bundleHash: r.bundleHash ?? undefined, objective: r.objective ?? undefined,
    datasetScope: r.datasetScope, holdoutPolicy: r.holdoutPolicy,
    holdoutBoundary: r.holdoutBoundary ?? undefined,
    status: r.status, verdict: r.verdict ?? undefined, verdictReason: r.verdictReason ?? undefined,
    aggregateMetrics: (r.aggregateMetrics as Record<string, unknown> | null) ?? undefined,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    completedAt: r.completedAt ? r.completedAt.toISOString() : undefined,
  };
}
export function memToDomain(r: MemRow): ExperimentRunMember {
  return {
    id: r.id, experimentId: r.experimentId, backtestRunId: r.backtestRunId ?? undefined,
    strategyBacktestRunId: r.strategyBacktestRunId ?? undefined,
    role: r.role, foldId: r.foldId ?? undefined,
    periodFrom: r.periodFrom.toISOString(), periodTo: r.periodTo.toISOString(),
    symbols: r.symbols, paramsHash: r.paramsHash, bundleHash: r.bundleHash,
    tradeCount: r.tradeCount ?? undefined, resultSummary: r.resultSummary ?? undefined,
    createdAt: r.createdAt.toISOString(),
  };
}

export class DrizzleResearchExperimentRepository implements ResearchExperimentRepository {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  async createExperiment(e: ResearchExperiment): Promise<void> {
    await this.db.insert(researchExperiment).values({
      id: e.id, experimentKey: e.experimentKey, experimentType: e.experimentType,
      strategyProfileId: e.strategyProfileId, hypothesisId: e.hypothesisId ?? null,
      buildId: e.buildId ?? null, bundleHash: e.bundleHash ?? null, objective: e.objective ?? null,
      datasetScope: e.datasetScope, holdoutPolicy: e.holdoutPolicy,
      holdoutBoundary: e.holdoutBoundary ?? null, status: e.status,
      verdict: e.verdict ?? null, verdictReason: e.verdictReason ?? null,
      aggregateMetrics: e.aggregateMetrics ?? null,
      createdAt: new Date(e.createdAt), updatedAt: new Date(e.updatedAt),
      completedAt: e.completedAt ? new Date(e.completedAt) : null,
    });
  }
  async findById(id: string): Promise<ResearchExperiment | null> {
    const rows = await this.db.select().from(researchExperiment).where(eq(researchExperiment.id, id)).limit(1);
    return rows[0] ? expToDomain(rows[0]) : null;
  }
  async findByKey(key: string): Promise<ResearchExperiment | null> {
    const rows = await this.db.select().from(researchExperiment).where(eq(researchExperiment.experimentKey, key)).limit(1);
    return rows[0] ? expToDomain(rows[0]) : null;
  }
  async updateExperiment(id: string, patch: Partial<ResearchExperiment>): Promise<void> {
    const set: Record<string, unknown> = { updatedAt: new Date(patch.updatedAt ?? new Date().toISOString()) };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.verdict !== undefined) set.verdict = patch.verdict;
    if (patch.verdictReason !== undefined) set.verdictReason = patch.verdictReason;
    if (patch.holdoutBoundary !== undefined) set.holdoutBoundary = patch.holdoutBoundary;
    if (patch.aggregateMetrics !== undefined) set.aggregateMetrics = patch.aggregateMetrics;
    if (patch.completedAt !== undefined) set.completedAt = patch.completedAt ? new Date(patch.completedAt) : null;
    await this.db.update(researchExperiment).set(set).where(eq(researchExperiment.id, id));
  }
  async addMember(m: ExperimentRunMember): Promise<void> {
    await this.db.insert(experimentRunMember).values({
      id: m.id, experimentId: m.experimentId, backtestRunId: m.backtestRunId ?? null,
      strategyBacktestRunId: m.strategyBacktestRunId ?? null,
      role: m.role, foldId: m.foldId ?? null,
      periodFrom: new Date(m.periodFrom), periodTo: new Date(m.periodTo),
      symbols: m.symbols, paramsHash: m.paramsHash, bundleHash: m.bundleHash,
      tradeCount: m.tradeCount ?? null, resultSummary: m.resultSummary ?? null,
      createdAt: new Date(m.createdAt),
    });
  }
  async updateMember(id: string, patch: Partial<ExperimentRunMember>): Promise<void> {
    const set: Record<string, unknown> = {};
    if (patch.backtestRunId !== undefined) set.backtestRunId = patch.backtestRunId;
    if (patch.strategyBacktestRunId !== undefined) set.strategyBacktestRunId = patch.strategyBacktestRunId;
    if (patch.tradeCount !== undefined) set.tradeCount = patch.tradeCount;
    if (patch.resultSummary !== undefined) set.resultSummary = patch.resultSummary;
    await this.db.update(experimentRunMember).set(set).where(eq(experimentRunMember.id, id));
  }
  async listMembers(experimentId: string): Promise<ExperimentRunMember[]> {
    const rows = await this.db.select().from(experimentRunMember).where(eq(experimentRunMember.experimentId, experimentId));
    return rows.map(memToDomain).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async addEvaluation(ev: ExperimentEvaluation): Promise<void> {
    await this.db.insert(experimentEvaluation).values({
      id: ev.id, experimentId: ev.experimentId, evaluatorVersion: ev.evaluatorVersion,
      rawScores: ev.rawScores, flags: ev.flags, verdict: ev.verdict,
      verdictReason: ev.verdictReason ?? null, createdAt: new Date(ev.createdAt),
    });
  }
}
