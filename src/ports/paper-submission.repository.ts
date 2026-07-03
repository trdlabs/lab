import type { PaperSubmission } from '../domain/paper-submission.ts';

export interface PaperSubmissionRepository {
  upsertByExperimentId(s: PaperSubmission): Promise<void>; // insert or replace-by-experimentId (id/createdAt preserved on update)
  findByExperimentId(experimentId: string): Promise<PaperSubmission | null>;
}
