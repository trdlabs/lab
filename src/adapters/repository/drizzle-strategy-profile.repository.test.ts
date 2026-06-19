import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDbClient } from '../../db/client.ts';
import { DrizzleStrategyProfileRepository } from './drizzle-strategy-profile.repository.ts';
import { strategyProfile } from '../../db/schema.ts';
import { AnalystProfileOutputSchema } from '../../domain/strategy-profile.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { ArtifactRef } from '../../domain/types.ts';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

const ref: ArtifactRef = {
  artifact_id: 'sha256:aa', uri: 'memory://aa', content_hash: 'sha256:aa', kind: 'strategy_source',
  size_bytes: 1, mime_type: 'text/plain', created_at: '2026-06-11T00:00:00Z', producer: 'test', metadata: {},
};
const sampleProfile = AnalystProfileOutputSchema.parse({
  direction: 'long', coreIdea: 'c', summary: 's', requiredMarketFeatures: ['oi'], entryConditions: [],
  exitConditions: [], timeframes: ['1h'], indicators: [], parameters: [], watchLifecycleSummary: null,
  positionManagementSummary: null, riskManagementSummary: null, runnerOwnedAuthorities: [],
  confidence: 0.7, unknowns: [], evidence: [],
});
const profile = (over: Partial<StrategyProfile> = {}): StrategyProfile => ({
  id: crypto.randomUUID(), version: 1, sourceKind: 'article', sourceFingerprint: `sha256:${crypto.randomUUID()}`,
  direction: 'long', coreIdea: 'c', requiredMarketFeatures: ['oi'], confidence: 0.7, unknowns: [],
  profile: sampleProfile, sourceArtifactRef: ref, contractVersion: 'strategy-profile-v1',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over,
});

d('DrizzleStrategyProfileRepository (integration)', () => {
  const { db, pool } = createDbClient(url!);
  const repo = new DrizzleStrategyProfileRepository(db);
  beforeAll(async () => { await db.delete(strategyProfile); });
  afterAll(async () => { await pool.end(); });

  it('creates and finds by id and fingerprint, preserving JSONB', async () => {
    const p = profile({ sourceFingerprint: 'sha256:fp-int-1' });
    await repo.create(p);
    const byId = await repo.findById(p.id);
    expect(byId?.profile.requiredMarketFeatures).toEqual(['oi']);
    expect(byId?.sourceArtifactRef.content_hash).toBe('sha256:aa');
    expect((await repo.findByFingerprint('sha256:fp-int-1'))?.id).toBe(p.id);
  });

  it('rejects a second profile with the same fingerprint (unique index)', async () => {
    const fp = 'sha256:fp-int-dup';
    await repo.create(profile({ sourceFingerprint: fp }));
    await expect(repo.create(profile({ sourceFingerprint: fp }))).rejects.toThrow();
  });

  it('listAll returns profiles ordered by createdAt ASC, id ASC', async () => {
    const t1 = new Date('2026-06-11T00:00:00Z').toISOString();
    const t2 = new Date('2026-06-12T00:00:00Z').toISOString();
    const t3 = new Date('2026-06-13T00:00:00Z').toISOString();
    // Insert in non-chronological order
    await repo.create(profile({ id: 'zz', sourceFingerprint: 'sha256:zz', createdAt: t3 }));
    await repo.create(profile({ id: 'aa', sourceFingerprint: 'sha256:list-aa', createdAt: t1 }));
    await repo.create(profile({ id: 'mm', sourceFingerprint: 'sha256:list-mm', createdAt: t2 }));
    const all = await repo.listAll();
    // Filter to the ones we just inserted (beforeAll deleted everything, but other tests
    // may have inserted rows already — safe because beforeAll cleared the table)
    const ids = all.map((p) => p.id);
    const relevant = ids.filter((id) => ['zz', 'aa', 'mm'].includes(id));
    expect(relevant).toEqual(['aa', 'mm', 'zz']);
  });
});
