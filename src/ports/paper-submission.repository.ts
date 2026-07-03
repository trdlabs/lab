import type { PaperSubmission } from '../domain/paper-submission.ts';

export interface PaperSubmissionRepository {
  upsertByExperimentId(s: PaperSubmission): Promise<void>; // insert or replace-by-experimentId (id/createdAt preserved on update)
  findByExperimentId(experimentId: string): Promise<PaperSubmission | null>;
  // Patches only the named monitor fields (defined keys only) + updatedAt; throws with the
  // experimentId in the message when no row exists for it.
  updateMonitorState(experimentId: string, patch: Partial<Pick<PaperSubmission,
    'strategyName' | 'paperRunId' | 'runStartedAtMs' | 'monitorStatus' | 'observedTrades' | 'windowPolicy' | 'lowConfidence'>> & { updatedAt: string }): Promise<void>;
}
