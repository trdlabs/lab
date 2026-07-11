import { describe, it, expect } from 'vitest';
import { InMemoryStrategyRevisionRepository } from './in-memory-strategy-revision.repository.ts';
import type { StrategyRevision } from '../../domain/strategy-revision.ts';
import { DEFAULT_PRESERVATION_THRESHOLDS } from '../../validation/trade-preservation.ts';

const row = (over: Partial<StrategyRevision> = {}): StrategyRevision => ({
  id: 'rev-1', strategyProfileId: 'prof-1', version: 1,
  hypothesisIds: ['hyp-1', 'hyp-2'],
  mergedRuleSet: { order: ['hyp-1', 'hyp-2'], rules: [] },
  status: 'candidate',
  createdAt: '2026-07-03T00:00:00.000Z', updatedAt: '2026-07-03T00:00:00.000Z',
  ...over,
});

describe('InMemoryStrategyRevisionRepository', () => {
  it('round-trips a revision by id', async () => {
    const repo = new InMemoryStrategyRevisionRepository();
    await repo.create(row());
    expect(await repo.findById('rev-1')).toEqual(row());
  });

  it('returns null for unknown id', async () => {
    const repo = new InMemoryStrategyRevisionRepository();
    expect(await repo.findById('nope')).toBeNull();
  });

  it('findLatestAccepted picks the max version among accepted rows for the profile, ignoring other statuses/profiles', async () => {
    const repo = new InMemoryStrategyRevisionRepository();
    await repo.create(row({ id: 'rev-1', version: 1, status: 'accepted' }));
    await repo.create(row({ id: 'rev-2', version: 2, status: 'rejected' }));
    await repo.create(row({ id: 'rev-3', version: 3, status: 'accepted' }));
    await repo.create(row({ id: 'rev-4', version: 4, status: 'candidate' }));
    await repo.create(row({ id: 'rev-5', version: 9, status: 'accepted', strategyProfileId: 'prof-other' }));

    const latest = await repo.findLatestAccepted('prof-1');
    expect(latest?.id).toBe('rev-3');
    expect(latest?.version).toBe(3);
  });

  it('findLatestAccepted returns null when no accepted rows exist for the profile', async () => {
    const repo = new InMemoryStrategyRevisionRepository();
    await repo.create(row({ id: 'rev-1', version: 1, status: 'candidate' }));
    expect(await repo.findLatestAccepted('prof-1')).toBeNull();
  });

  it('updateStatus patches only defined fields, leaving others untouched', async () => {
    const repo = new InMemoryStrategyRevisionRepository();
    await repo.create(row({ verdictReason: 'initial', metrics: { sharpe: 1 } }));
    await repo.updateStatus('rev-1', { status: 'accepted', updatedAt: '2026-07-04T00:00:00.000Z' });
    const got = await repo.findById('rev-1');
    expect(got?.status).toBe('accepted');
    expect(got?.updatedAt).toBe('2026-07-04T00:00:00.000Z');
    // untouched fields
    expect(got?.verdictReason).toBe('initial');
    expect(got?.metrics).toEqual({ sharpe: 1 });
    expect(got?.hypothesisIds).toEqual(['hyp-1', 'hyp-2']);
  });

  it('updateStatus does not clear fields omitted from the patch even when previously set', async () => {
    const repo = new InMemoryStrategyRevisionRepository();
    await repo.create(row({ dropped: [{ hypothesisId: 'hyp-9', reason: 'combo_fail_dropped', detail: 'x' }] }));
    await repo.updateStatus('rev-1', { comboBacktestRunId: 'sbr-1', updatedAt: '2026-07-04T00:00:00.000Z' });
    const got = await repo.findById('rev-1');
    expect(got?.comboBacktestRunId).toBe('sbr-1');
    expect(got?.dropped).toEqual([{ hypothesisId: 'hyp-9', reason: 'combo_fail_dropped', detail: 'x' }]);
  });

  it('updateStatus throws with the id in the message for an unknown id', async () => {
    const repo = new InMemoryStrategyRevisionRepository();
    await expect(repo.updateStatus('nope', { status: 'accepted', updatedAt: '2026-07-04T00:00:00.000Z' }))
      .rejects.toThrow(/nope/);
  });

  it('create enforces UNIQUE(strategyProfileId, version) in-memory', async () => {
    const repo = new InMemoryStrategyRevisionRepository();
    await repo.create(row({ id: 'rev-1', strategyProfileId: 'prof-1', version: 1 }));
    await expect(repo.create(row({ id: 'rev-2', strategyProfileId: 'prof-1', version: 1 })))
      .rejects.toThrow();
  });

  it('allows the same version across different profiles', async () => {
    const repo = new InMemoryStrategyRevisionRepository();
    await repo.create(row({ id: 'rev-1', strategyProfileId: 'prof-1', version: 1 }));
    await repo.create(row({ id: 'rev-2', strategyProfileId: 'prof-2', version: 1 }));
    expect(await repo.findById('rev-1')).not.toBeNull();
    expect(await repo.findById('rev-2')).not.toBeNull();
  });

  it('listByProfile returns rows for the profile ordered by version ascending', async () => {
    const repo = new InMemoryStrategyRevisionRepository();
    await repo.create(row({ id: 'rev-3', strategyProfileId: 'prof-1', version: 3 }));
    await repo.create(row({ id: 'rev-1', strategyProfileId: 'prof-1', version: 1 }));
    await repo.create(row({ id: 'rev-2', strategyProfileId: 'prof-1', version: 2 }));
    await repo.create(row({ id: 'rev-other', strategyProfileId: 'prof-2', version: 1 }));

    const list = await repo.listByProfile('prof-1');
    expect(list.map((r) => r.id)).toEqual(['rev-1', 'rev-2', 'rev-3']);
  });

  it('listByProfile returns an empty array for a profile with no revisions', async () => {
    const repo = new InMemoryStrategyRevisionRepository();
    expect(await repo.listByProfile('nope')).toEqual([]);
  });

  it('round-trips kind/compositionDepth/consolidatedFromRevisionId/baselineValidationStatus', async () => {
    const repo = new InMemoryStrategyRevisionRepository();
    await repo.create(row({
      kind: 'consolidated',
      compositionDepth: 1,
      consolidatedFromRevisionId: 'rev-source',
      baselineValidationStatus: 'passed',
    }));
    const got = await repo.findById('rev-1');
    expect(got?.kind).toBe('consolidated');
    expect(got?.compositionDepth).toBe(1);
    expect(got?.consolidatedFromRevisionId).toBe('rev-source');
    expect(got?.baselineValidationStatus).toBe('passed');
  });

  it('findConsolidatedOf returns the consolidated materialization of R', async () => {
    const repo = new InMemoryStrategyRevisionRepository();
    await repo.create(row({ id: 'R', kind: 'composed', version: 3 }));
    expect(await repo.findConsolidatedOf('R')).toBeNull();
    await repo.create(row({ id: 'C', kind: 'consolidated', consolidatedFromRevisionId: 'R', version: 4 }));
    expect((await repo.findConsolidatedOf('R'))?.id).toBe('C');
  });

  it('updateStatus patches baselineValidationStatus and baselineExperimentId', async () => {
    const repo = new InMemoryStrategyRevisionRepository();
    await repo.create(row({ baselineValidationStatus: 'pending' }));
    await repo.updateStatus('rev-1', {
      baselineValidationStatus: 'passed',
      baselineExperimentId: 'exp-1',
      updatedAt: '2026-07-04T00:00:00.000Z',
    });
    const got = await repo.findById('rev-1');
    expect(got?.baselineValidationStatus).toBe('passed');
    expect(got?.baselineExperimentId).toBe('exp-1');
  });

  it('updateStatus round-trips preservationGate through the in-memory repo', async () => {
    const repo = new InMemoryStrategyRevisionRepository();
    await repo.create(row());
    await repo.updateStatus('rev-1', {
      preservationGate: {
        fired: true,
        reason: 'winner_degradation',
        metrics: {
          totalDelta: 1,
          matchedCount: 0,
          disappearedCount: 0,
          newCount: 0,
          baselineWinnerCount: 0,
        },
        thresholds: DEFAULT_PRESERVATION_THRESHOLDS,
      },
      updatedAt: '2026-07-04T00:00:00.000Z',
    });
    const got = await repo.findById('rev-1');
    expect(got?.preservationGate?.reason).toBe('winner_degradation');
    expect(got?.preservationGate?.fired).toBe(true);
    expect(got?.preservationGate?.metrics.totalDelta).toBe(1);
  });
});
