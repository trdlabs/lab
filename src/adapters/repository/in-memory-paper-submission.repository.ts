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

  async updateMonitorState(experimentId: string, patch: Partial<Pick<PaperSubmission,
    'strategyName' | 'paperRunId' | 'runStartedAtMs' | 'monitorStatus' | 'observedTrades' | 'windowPolicy' | 'lowConfidence'>> & { updatedAt: string }): Promise<void> {
    const existing = this.byExperimentId.get(experimentId);
    if (!existing) throw new Error(`paper submission not found for experimentId: ${experimentId}`);
    const definedPatch = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    this.byExperimentId.set(experimentId, { ...existing, ...definedPatch });
  }

  async listWatching(): Promise<PaperSubmission[]> {
    return [...this.byExperimentId.values()].filter((s) => s.monitorStatus === 'watching');
  }
}
