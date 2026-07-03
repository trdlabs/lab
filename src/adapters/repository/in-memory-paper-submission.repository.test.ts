import { describe, it, expect } from 'vitest';
import { InMemoryPaperSubmissionRepository } from './in-memory-paper-submission.repository.ts';
import type { PaperSubmission } from '../../domain/paper-submission.ts';

const row = (over: Partial<PaperSubmission> = {}): PaperSubmission => ({
  id: 'ps-1', experimentId: 'exp-1', strategyProfileId: 'prof-1',
  submissionStatus: 'submitted', candidateId: 'cand-1', admissionStatus: 'admitted',
  idempotencyKey: 'wfo-champion:exp-1', bundleHash: 'sha256:aa',
  params: { dumpPct: 8 }, createdAt: '2026-07-03T00:00:00.000Z', updatedAt: '2026-07-03T00:00:00.000Z',
  ...over,
});

describe('InMemoryPaperSubmissionRepository', () => {
  it('round-trips a submission by experimentId', async () => {
    const repo = new InMemoryPaperSubmissionRepository();
    await repo.upsertByExperimentId(row());
    expect(await repo.findByExperimentId('exp-1')).toEqual(row());
  });

  it('upsert replaces the existing row for the same experimentId (id/createdAt preserved)', async () => {
    const repo = new InMemoryPaperSubmissionRepository();
    await repo.upsertByExperimentId(row({ submissionStatus: 'failed', error: { category: 'validation_error' }, candidateId: undefined, admissionStatus: undefined }));
    await repo.upsertByExperimentId(row({ id: 'ps-2', createdAt: '2026-07-04T00:00:00.000Z', updatedAt: '2026-07-04T00:00:00.000Z' }));
    const got = await repo.findByExperimentId('exp-1');
    expect(got?.submissionStatus).toBe('submitted');
    expect(got?.id).toBe('ps-1');                                // original id preserved
    expect(got?.createdAt).toBe('2026-07-03T00:00:00.000Z');     // original createdAt preserved
    expect(got?.updatedAt).toBe('2026-07-04T00:00:00.000Z');
    expect(got?.error).toBeUndefined();                          // replaced, not merged
  });

  it('returns null for unknown experimentId', async () => {
    const repo = new InMemoryPaperSubmissionRepository();
    expect(await repo.findByExperimentId('nope')).toBeNull();
  });
});
