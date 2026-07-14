import { describe, it, expect } from 'vitest';
import { InMemoryCycleScorecardRepository } from './in-memory-cycle-scorecard.repository.ts';
import type { CycleScorecardRow } from '../../ports/cycle-scorecard.repository.ts';
import type { CycleScorecard } from '../../domain/cycle-scorecard.ts';
import { CYCLE_SCORECARD_SCHEMA_VERSION } from '../../domain/cycle-scorecard.ts';

const scorecard = (over: Partial<CycleScorecard> = {}): CycleScorecard => ({
  schemaVersion: CYCLE_SCORECARD_SCHEMA_VERSION,
  correlationId: 'corr-1',
  strategyProfileId: 'profile-1',
  terminalOutcome: { kind: 'accepted', reason: 'cycle_closed' },
  counts: { built: 3, evaluated: 3, eligible: 2, considered: 2, selected: 1, dropped: 1 },
  provenance: { mergeAttempted: true, candidateIncluded: 1, revisionId: 'rev-1' },
  revisionAssessment: null,
  champion: { revisionId: 'rev-1', version: 1 },
  selectionBias: { n: 2, considered: 2, selected: 1 },
  roster: [],
  verdict: { decision: 'accept', reason: 'best_of_cycle' },
  ...over,
});

const row = (over: Partial<CycleScorecardRow> = {}): CycleScorecardRow => ({
  id: 'sc-1',
  correlationId: 'corr-1',
  strategyProfileId: 'profile-1',
  schemaVersion: CYCLE_SCORECARD_SCHEMA_VERSION,
  payload: scorecard(),
  generatedAt: '2026-07-14T00:00:00.000Z',
  createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
  ...over,
});

describe('InMemoryCycleScorecardRepository', () => {
  it('round-trips: upsert then findByCorrelation returns the row', async () => {
    const repo = new InMemoryCycleScorecardRepository();
    await repo.upsert(row());
    const found = await repo.findByCorrelation('corr-1');
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual(row());
  });

  it('findByCorrelationAndSchema returns the matching row', async () => {
    const repo = new InMemoryCycleScorecardRepository();
    await repo.upsert(row());
    const found = await repo.findByCorrelationAndSchema('corr-1', CYCLE_SCORECARD_SCHEMA_VERSION);
    expect(found).toEqual(row());
  });

  it('findByCorrelationAndSchema returns null when no row matches', async () => {
    const repo = new InMemoryCycleScorecardRepository();
    const found = await repo.findByCorrelationAndSchema('corr-missing', CYCLE_SCORECARD_SCHEMA_VERSION);
    expect(found).toBeNull();
  });

  it('a second upsert with the same (correlationId, schemaVersion) replaces — one entry, latest payload', async () => {
    const repo = new InMemoryCycleScorecardRepository();
    await repo.upsert(row({ payload: scorecard({ verdict: { decision: 'accept', reason: 'first' } }) }));
    await repo.upsert(row({
      id: 'sc-2', // even a different id must not create a second entry — the unique key is (correlationId, schemaVersion)
      payload: scorecard({ verdict: { decision: 'accept', reason: 'second' } }),
      updatedAt: '2026-07-14T01:00:00.000Z',
    }));

    const all = await repo.findByCorrelation('corr-1');
    expect(all).toHaveLength(1);

    const found = await repo.findByCorrelationAndSchema('corr-1', CYCLE_SCORECARD_SCHEMA_VERSION);
    expect(found?.payload.verdict.reason).toBe('second');
    expect(found?.updatedAt).toBe('2026-07-14T01:00:00.000Z');
  });

  it('different schemaVersion for the same correlationId does not collide', async () => {
    const repo = new InMemoryCycleScorecardRepository();
    await repo.upsert(row());
    await repo.upsert(row({ id: 'sc-3', schemaVersion: 'cycle-scorecard-v2' }));

    const all = await repo.findByCorrelation('corr-1');
    expect(all).toHaveLength(2);
  });
});
