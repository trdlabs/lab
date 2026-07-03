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

  it('round-trips the seven monitor fields through upsert+find', async () => {
    const repo = new InMemoryPaperSubmissionRepository();
    await repo.upsertByExperimentId(row({
      strategyName: 'long_oi', paperRunId: 'run-1', runStartedAtMs: 1_720_000_000_000,
      monitorStatus: 'watching', observedTrades: 3,
      windowPolicy: { minTrades: 5, maxWindowMs: 86_400_000 }, lowConfidence: true,
    }));
    expect(await repo.findByExperimentId('exp-1')).toEqual(row({
      strategyName: 'long_oi', paperRunId: 'run-1', runStartedAtMs: 1_720_000_000_000,
      monitorStatus: 'watching', observedTrades: 3,
      windowPolicy: { minTrades: 5, maxWindowMs: 86_400_000 }, lowConfidence: true,
    }));
  });

  it('updateMonitorState patches only named fields, leaving others untouched', async () => {
    const repo = new InMemoryPaperSubmissionRepository();
    await repo.upsertByExperimentId(row({
      strategyName: 'long_oi', paperRunId: 'run-1', runStartedAtMs: 1_720_000_000_000,
      monitorStatus: 'watching', observedTrades: 3,
      windowPolicy: { minTrades: 5 }, lowConfidence: false,
    }));
    await repo.updateMonitorState('exp-1', { observedTrades: 4, updatedAt: '2026-07-05T00:00:00.000Z' });
    const got = await repo.findByExperimentId('exp-1');
    expect(got?.observedTrades).toBe(4);
    expect(got?.updatedAt).toBe('2026-07-05T00:00:00.000Z');
    // untouched fields
    expect(got?.strategyName).toBe('long_oi');
    expect(got?.paperRunId).toBe('run-1');
    expect(got?.runStartedAtMs).toBe(1_720_000_000_000);
    expect(got?.monitorStatus).toBe('watching');
    expect(got?.windowPolicy).toEqual({ minTrades: 5 });
    expect(got?.lowConfidence).toBe(false);
    // core (non-monitor) fields untouched too
    expect(got?.submissionStatus).toBe('submitted');
    expect(got?.id).toBe('ps-1');
  });

  it('updateMonitorState throws with the experimentId in the message for an unknown experimentId', async () => {
    const repo = new InMemoryPaperSubmissionRepository();
    await expect(repo.updateMonitorState('nope', { updatedAt: '2026-07-05T00:00:00.000Z' }))
      .rejects.toThrow(/nope/);
  });

  it('listWatching returns only rows with monitorStatus === watching', async () => {
    const repo = new InMemoryPaperSubmissionRepository();
    await repo.upsertByExperimentId(row({ experimentId: 'exp-watching-1', monitorStatus: 'watching' }));
    await repo.upsertByExperimentId(row({ experimentId: 'exp-complete', monitorStatus: 'window_complete' }));
    await repo.upsertByExperimentId(row({ experimentId: 'exp-stalled', monitorStatus: 'stalled' }));
    await repo.upsertByExperimentId(row({ experimentId: 'exp-no-monitor', monitorStatus: undefined }));
    await repo.upsertByExperimentId(row({ experimentId: 'exp-watching-2', monitorStatus: 'watching' }));

    const watching = await repo.listWatching();
    expect(watching.map((r) => r.experimentId).sort()).toEqual(['exp-watching-1', 'exp-watching-2']);
  });

  it('listWatching returns an empty array when no rows are watching', async () => {
    const repo = new InMemoryPaperSubmissionRepository();
    await repo.upsertByExperimentId(row({ monitorStatus: 'window_complete' }));
    expect(await repo.listWatching()).toEqual([]);
  });
});
