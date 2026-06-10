import { describe, it, expect } from 'vitest';
import { InMemoryStrategyProfileRepository } from './in-memory-strategy-profile.repository.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { ArtifactRef } from '../../domain/types.ts';

const ref: ArtifactRef = {
  artifact_id: 'sha256:aa', uri: 'memory://aa', content_hash: 'sha256:aa', kind: 'strategy_source',
  size_bytes: 1, mime_type: 'text/plain', created_at: '2026-06-11T00:00:00Z', producer: 'test', metadata: {},
};
const profile = (over: Partial<StrategyProfile> = {}): StrategyProfile => ({
  id: 'p1', version: 1, sourceKind: 'article', sourceFingerprint: 'sha256:fp1', direction: 'long',
  coreIdea: 'idea', requiredMarketFeatures: [], confidence: 0.5, unknowns: [],
  profile: {} as StrategyProfile['profile'], sourceArtifactRef: ref, contractVersion: 'strategy-profile-v1',
  createdAt: '2026-06-11T00:00:00Z', updatedAt: '2026-06-11T00:00:00Z', ...over,
});

describe('InMemoryStrategyProfileRepository', () => {
  it('creates and finds by id and fingerprint', async () => {
    const repo = new InMemoryStrategyProfileRepository();
    await repo.create(profile({ id: 'a', sourceFingerprint: 'sha256:x' }));
    expect((await repo.findById('a'))?.id).toBe('a');
    expect((await repo.findByFingerprint('sha256:x'))?.id).toBe('a');
    expect(await repo.findById('missing')).toBeNull();
    expect(await repo.findByFingerprint('nope')).toBeNull();
  });
  it('throws on duplicate id', async () => {
    const repo = new InMemoryStrategyProfileRepository();
    await repo.create(profile({ id: 'a' }));
    await expect(repo.create(profile({ id: 'a' }))).rejects.toThrow(/already exists/);
  });
  it('throws on duplicate sourceFingerprint (mirrors the DB unique index)', async () => {
    const repo = new InMemoryStrategyProfileRepository();
    await repo.create(profile({ id: 'a', sourceFingerprint: 'sha256:dup' }));
    await expect(repo.create(profile({ id: 'b', sourceFingerprint: 'sha256:dup' }))).rejects.toThrow(/fingerprint/);
  });
});
