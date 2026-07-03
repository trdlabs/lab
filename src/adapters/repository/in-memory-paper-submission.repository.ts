import type { PaperSubmission } from '../../domain/paper-submission.ts';
import type { PaperSubmissionRepository } from '../../ports/paper-submission.repository.ts';

export class InMemoryPaperSubmissionRepository implements PaperSubmissionRepository {
  private readonly byExperimentId = new Map<string, PaperSubmission>();

  async upsertByExperimentId(s: PaperSubmission): Promise<void> {
    const existing = this.byExperimentId.get(s.experimentId);
    const row: PaperSubmission = existing
      ? { ...s, id: existing.id, createdAt: existing.createdAt }
      : { ...s };
    this.byExperimentId.set(s.experimentId, row);
  }

  async findByExperimentId(experimentId: string): Promise<PaperSubmission | null> {
    return this.byExperimentId.get(experimentId) ?? null;
  }
}
