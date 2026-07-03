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
      },
    });
  }

  async findByExperimentId(experimentId: string): Promise<PaperSubmission | null> {
    const rows = await this.db.select().from(paperSubmission).where(eq(paperSubmission.experimentId, experimentId)).limit(1);
    return rows[0] ? paperSubmissionToDomain(rows[0]) : null;
  }
}
