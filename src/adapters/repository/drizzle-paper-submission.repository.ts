import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { paperSubmission } from '../../db/schema.ts';
import type { PaperSubmission } from '../../domain/paper-submission.ts';
import type { PaperSubmissionRepository } from '../../ports/paper-submission.repository.ts';

export type PaperSubmissionRow = typeof paperSubmission.$inferSelect;

// Exported so other adapters can reuse the SAME mapper — single source of truth.
export function paperSubmissionToDomain(r: PaperSubmissionRow): PaperSubmission {
  return {
    id: r.id, experimentId: r.experimentId, strategyProfileId: r.strategyProfileId,
    submissionStatus: r.submissionStatus,
    candidateId: r.candidateId ?? undefined,
    admissionStatus: r.admissionStatus ?? undefined,
    admissionReasonCode: r.admissionReasonCode ?? undefined,
    error: (r.error as Record<string, unknown> | null) ?? undefined,
    idempotencyKey: r.idempotencyKey, bundleHash: r.bundleHash,
    params: (r.params as Record<string, unknown> | null) ?? undefined,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    strategyName: r.strategyName ?? undefined,
    paperRunId: r.paperRunId ?? undefined,
    runStartedAtMs: r.runStartedAtMs ?? undefined,
    monitorStatus: (r.monitorStatus as PaperSubmission['monitorStatus']) ?? undefined,
    observedTrades: r.observedTrades ?? undefined,
    windowPolicy: (r.windowPolicy as Record<string, unknown> | null) ?? undefined,
    lowConfidence: r.lowConfidence ?? undefined,
  };
}

export class DrizzlePaperSubmissionRepository implements PaperSubmissionRepository {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  async upsertByExperimentId(s: PaperSubmission): Promise<void> {
    const values = {
      id: s.id, experimentId: s.experimentId, strategyProfileId: s.strategyProfileId,
      submissionStatus: s.submissionStatus,
      candidateId: s.candidateId ?? null,
      admissionStatus: s.admissionStatus ?? null,
      admissionReasonCode: s.admissionReasonCode ?? null,
      error: s.error ?? null,
      idempotencyKey: s.idempotencyKey, bundleHash: s.bundleHash,
      params: s.params ?? null,
      createdAt: new Date(s.createdAt), updatedAt: new Date(s.updatedAt),
      strategyName: s.strategyName ?? null,
      paperRunId: s.paperRunId ?? null,
      runStartedAtMs: s.runStartedAtMs ?? null,
      monitorStatus: s.monitorStatus ?? null,
      observedTrades: s.observedTrades ?? null,
      windowPolicy: s.windowPolicy ?? null,
      lowConfidence: s.lowConfidence ?? null,
    };
    await this.db.insert(paperSubmission).values(values).onConflictDoUpdate({
      target: paperSubmission.experimentId,
      set: {
        strategyProfileId: values.strategyProfileId,
        submissionStatus: values.submissionStatus,
        candidateId: values.candidateId,
        admissionStatus: values.admissionStatus,
        admissionReasonCode: values.admissionReasonCode,
        error: values.error,
        idempotencyKey: values.idempotencyKey,
        bundleHash: values.bundleHash,
        params: values.params,
        updatedAt: values.updatedAt,
        strategyName: values.strategyName,
        paperRunId: values.paperRunId,
        runStartedAtMs: values.runStartedAtMs,
        monitorStatus: values.monitorStatus,
        observedTrades: values.observedTrades,
        windowPolicy: values.windowPolicy,
        lowConfidence: values.lowConfidence,
      },
    });
  }

  async findByExperimentId(experimentId: string): Promise<PaperSubmission | null> {
    const rows = await this.db.select().from(paperSubmission).where(eq(paperSubmission.experimentId, experimentId)).limit(1);
    return rows[0] ? paperSubmissionToDomain(rows[0]) : null;
  }

  async updateMonitorState(experimentId: string, patch: Partial<Pick<PaperSubmission,
    'strategyName' | 'paperRunId' | 'runStartedAtMs' | 'monitorStatus' | 'observedTrades' | 'windowPolicy' | 'lowConfidence'>> & { updatedAt: string }): Promise<void> {
    const set: Record<string, unknown> = { updatedAt: new Date(patch.updatedAt) };
    if (patch.strategyName !== undefined) set.strategyName = patch.strategyName;
    if (patch.paperRunId !== undefined) set.paperRunId = patch.paperRunId;
    if (patch.runStartedAtMs !== undefined) set.runStartedAtMs = patch.runStartedAtMs;
    if (patch.monitorStatus !== undefined) set.monitorStatus = patch.monitorStatus;
    if (patch.observedTrades !== undefined) set.observedTrades = patch.observedTrades;
    if (patch.windowPolicy !== undefined) set.windowPolicy = patch.windowPolicy;
    if (patch.lowConfidence !== undefined) set.lowConfidence = patch.lowConfidence;

    const result = await this.db.update(paperSubmission).set(set).where(eq(paperSubmission.experimentId, experimentId)).returning({ id: paperSubmission.id });
    if (result.length === 0) throw new Error(`paper submission not found for experimentId: ${experimentId}`);
  }
}
