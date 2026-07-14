import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { cycleScorecardToDomain, DrizzleCycleScorecardRepository, type CycleScorecardDbRow } from './drizzle-cycle-scorecard.repository.ts';
import type { CycleScorecard } from '../../domain/cycle-scorecard.ts';
import { CYCLE_SCORECARD_SCHEMA_VERSION } from '../../domain/cycle-scorecard.ts';
import type { CycleScorecardRow } from '../../ports/cycle-scorecard.repository.ts';
import { createDbClient } from '../../db/client.ts';

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

const dbRow = (over: Partial<CycleScorecardDbRow> = {}): CycleScorecardDbRow => ({
  id: 'sc-1',
  correlationId: 'corr-1',
  strategyProfileId: 'profile-1',
  schemaVersion: CYCLE_SCORECARD_SCHEMA_VERSION,
  payload: scorecard(),
  generatedAt: new Date('2026-07-14T00:00:00Z'),
  createdAt: new Date('2026-07-14T00:00:00Z'),
  updatedAt: new Date('2026-07-14T00:00:00Z'),
  ...over,
});

describe('cycleScorecardToDomain', () => {
  it('maps a DB row to the domain CycleScorecardRow, converting timestamps to ISO strings', () => {
    const domain = cycleScorecardToDomain(dbRow());
    expect(domain).toEqual({
      id: 'sc-1',
      correlationId: 'corr-1',
      strategyProfileId: 'profile-1',
      schemaVersion: CYCLE_SCORECARD_SCHEMA_VERSION,
      payload: scorecard(),
      generatedAt: '2026-07-14T00:00:00.000Z',
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
    });
  });

  it('carries the payload through verbatim', () => {
    const payload = scorecard({ verdict: { decision: 'reject', reason: 'preservation_veto' } });
    const domain = cycleScorecardToDomain(dbRow({ payload }));
    expect(domain.payload).toEqual(payload);
  });
});

const url = process.env.DATABASE_URL;
(url ? describe : describe.skip)('DrizzleCycleScorecardRepository — upsert idempotency (integration)', () => {
  let repo: DrizzleCycleScorecardRepository;
  let pool: Pool;

  beforeAll(() => {
    const client = createDbClient(url as string);
    pool = client.pool;
    repo = new DrizzleCycleScorecardRepository(client.db);
  });

  afterAll(async () => {
    await pool.end(); // close the Postgres pool so the test process exits cleanly
  });

  it('upserting twice with identical (correlationId, schemaVersion) leaves ONE row with the second payload', async () => {
    const correlationId = 'corr-int-' + Date.now();
    const rowFixture = (over: Partial<CycleScorecardRow> = {}): CycleScorecardRow => ({
      id: 'sc-int-' + Date.now(),
      correlationId,
      strategyProfileId: 'profile-int-1',
      schemaVersion: CYCLE_SCORECARD_SCHEMA_VERSION,
      payload: scorecard({ correlationId }),
      generatedAt: '2026-07-14T00:00:00.000Z',
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
      ...over,
    });

    const firstPayload = scorecard({ correlationId, verdict: { decision: 'accept', reason: 'first' } });
    await repo.upsert(rowFixture({ payload: firstPayload }));

    const secondPayload = scorecard({ correlationId, verdict: { decision: 'accept', reason: 'second' } });
    await repo.upsert(rowFixture({
      id: 'sc-int-2-' + Date.now(), // a different id must not create a second row — the unique key is (correlationId, schemaVersion)
      payload: secondPayload,
      updatedAt: '2026-07-14T01:00:00.000Z',
    }));

    const all = await repo.findByCorrelation(correlationId);
    expect(all).toHaveLength(1);

    const found = await repo.findByCorrelationAndSchema(correlationId, CYCLE_SCORECARD_SCHEMA_VERSION);
    expect(found?.payload.verdict.reason).toBe('second');
  });
});
