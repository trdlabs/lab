import { describe, it, expect } from 'vitest';
import { InMemoryHypothesisProposalRepository } from './in-memory-hypothesis-proposal.repository.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';

function hyp(id: string, profileId: string, fp: string): HypothesisProposal {
  return {
    id, strategyProfileId: profileId, thesis: 't', targetBehavior: 'b',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'w', action: 'no_op', params: {} }] },
    requiredFeatures: ['oi'], validationPlan: 'p', expectedEffect: { metric: 'win_rate', direction: 'increase' },
    invalidationCriteria: ['x'], confidence: 0.5, status: 'validated', fingerprint: fp,
    proposal: {} as never, issues: [], contractVersion: 'hypothesis-proposal-v1',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('InMemoryHypothesisProposalRepository', () => {
  it('creates and finds by id', async () => {
    const repo = new InMemoryHypothesisProposalRepository();
    await repo.create(hyp('h1', 'p1', 'sha256:a'));
    expect((await repo.findById('h1'))?.id).toBe('h1');
    expect(await repo.findById('missing')).toBeNull();
  });

  it('throws on duplicate id', async () => {
    const repo = new InMemoryHypothesisProposalRepository();
    await repo.create(hyp('h1', 'p1', 'sha256:a'));
    await expect(repo.create(hyp('h1', 'p1', 'sha256:b'))).rejects.toThrow();
  });

  it('throws on duplicate (strategyProfileId, fingerprint) — mirrors the DB unique guard', async () => {
    const repo = new InMemoryHypothesisProposalRepository();
    await repo.create(hyp('h1', 'p1', 'sha256:dup'));
    // Same profile + same fingerprint, different id -> must still throw.
    await expect(repo.create(hyp('h2', 'p1', 'sha256:dup'))).rejects.toThrow();
    // Same fingerprint under a DIFFERENT profile is allowed (dedupe is per profile).
    await expect(repo.create(hyp('h3', 'p2', 'sha256:dup'))).resolves.toBeUndefined();
  });

  it('lists by strategy profile in insertion order', async () => {
    const repo = new InMemoryHypothesisProposalRepository();
    await repo.create(hyp('h1', 'p1', 'sha256:a'));
    await repo.create(hyp('h2', 'p2', 'sha256:b'));
    await repo.create(hyp('h3', 'p1', 'sha256:c'));
    expect((await repo.listByStrategyProfile('p1')).map((h) => h.id)).toEqual(['h1', 'h3']);
  });

  it('lists fingerprints for a profile', async () => {
    const repo = new InMemoryHypothesisProposalRepository();
    await repo.create(hyp('h1', 'p1', 'sha256:a'));
    await repo.create(hyp('h2', 'p1', 'sha256:c'));
    expect((await repo.listFingerprints('p1')).sort()).toEqual(['sha256:a', 'sha256:c']);
  });
});
