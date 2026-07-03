import { describe, it, expect } from 'vitest';
import { InMemoryHypothesisProposalRepository } from './in-memory-hypothesis-proposal.repository.ts';
import type { HypothesisProposal, HypothesisProxyMetrics } from '../../domain/hypothesis.ts';

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

  it('findLatestValidatedByProfile returns the newest validated row for the profile', async () => {
    const repo = new InMemoryHypothesisProposalRepository();
    const older: HypothesisProposal = { ...hyp('h1', 'p1', 'sha256:a'), createdAt: '2026-01-01T00:00:00Z' };
    const newer: HypothesisProposal = { ...hyp('h2', 'p1', 'sha256:b'), createdAt: '2026-02-01T00:00:00Z' };
    await repo.create(older);
    await repo.create(newer);
    expect((await repo.findLatestValidatedByProfile('p1'))?.id).toBe('h2');
  });

  it('findLatestValidatedByProfile ignores non-validated rows and other profiles', async () => {
    const repo = new InMemoryHypothesisProposalRepository();
    const rejected: HypothesisProposal = { ...hyp('h1', 'p1', 'sha256:a'), status: 'rejected' };
    const otherProfile: HypothesisProposal = { ...hyp('h2', 'p2', 'sha256:b') };
    await repo.create(rejected);
    await repo.create(otherProfile);
    expect(await repo.findLatestValidatedByProfile('p1')).toBeNull();
  });

  describe('updateStatus', () => {
    it('round-trips status and proxyMetrics', async () => {
      const repo = new InMemoryHypothesisProposalRepository();
      await repo.create(hyp('h1', 'p1', 'sha256:a'));
      const proxyMetrics: HypothesisProxyMetrics = {
        decision: 'PASS', deltaNetPnlUsd: 123.45, deltaMaxDrawdownPct: -1.2, backtestRunId: 'bt-1',
      };
      await repo.updateStatus('h1', 'proxy_passed', proxyMetrics);
      const found = await repo.findById('h1');
      expect(found?.status).toBe('proxy_passed');
      expect(found?.proxyMetrics).toEqual(proxyMetrics);
    });

    it('updates status without touching proxyMetrics when omitted', async () => {
      const repo = new InMemoryHypothesisProposalRepository();
      await repo.create(hyp('h1', 'p1', 'sha256:a'));
      await repo.updateStatus('h1', 'merged');
      const found = await repo.findById('h1');
      expect(found?.status).toBe('merged');
      expect(found?.proxyMetrics).toBeUndefined();
    });

    it('throws on unknown id, naming the id', async () => {
      const repo = new InMemoryHypothesisProposalRepository();
      await expect(repo.updateStatus('missing-id', 'proxy_failed')).rejects.toThrow('missing-id');
    });
  });
});
