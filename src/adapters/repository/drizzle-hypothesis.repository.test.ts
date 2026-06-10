import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { createDbClient } from '../../db/client.ts';
import { DrizzleHypothesisProposalRepository } from './drizzle-hypothesis-proposal.repository.ts';
import { DrizzleHypothesisReviewRepository } from './drizzle-hypothesis-review.repository.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';
import type { HypothesisReview } from '../../domain/critic.ts';

const url = process.env.DATABASE_URL;

function hyp(id: string, fp: string, status: 'validated' | 'rejected' = 'validated'): HypothesisProposal {
  return {
    id, strategyProfileId: 'p-drizzle', thesis: 'thesis ' + id, targetBehavior: 'b',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'w', action: 'no_op', params: { n: 1 } }] },
    requiredFeatures: ['oi'], validationPlan: 'p', expectedEffect: { metric: 'win_rate', direction: 'increase' },
    invalidationCriteria: ['x'], confidence: 0.5, status, fingerprint: fp,
    proposal: {} as never, issues: [], contractVersion: 'hypothesis-proposal-v1',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

(url ? describe : describe.skip)('Drizzle hypothesis repositories (integration)', () => {
  let proposals: DrizzleHypothesisProposalRepository;
  let reviews: DrizzleHypothesisReviewRepository;
  let pool: Pool;

  beforeAll(() => {
    const client = createDbClient(url as string);
    pool = client.pool;
    proposals = new DrizzleHypothesisProposalRepository(client.db);
    reviews = new DrizzleHypothesisReviewRepository(client.db);
  });

  afterAll(async () => {
    await pool.end(); // close the Postgres pool so the test process exits cleanly
  });

  it('persists and reads back a proposal', async () => {
    const id = 'h-' + Date.now();
    await proposals.create(hyp(id, 'sha256:' + id));
    const found = await proposals.findById(id);
    expect(found?.id).toBe(id);
    expect(found?.ruleAction.rules[0]!.action).toBe('no_op');
  });

  it('lists fingerprints for a profile', async () => {
    const fps = await proposals.listFingerprints('p-drizzle');
    expect(Array.isArray(fps)).toBe(true);
  });

  it('enforces the unique (profile, fingerprint) index', async () => {
    const fp = 'sha256:dup-' + Date.now();
    await proposals.create(hyp('a-' + Date.now(), fp));
    await expect(proposals.create(hyp('b-' + Date.now(), fp))).rejects.toThrow();
  });

  it('persists and lists a review', async () => {
    const hid = 'h-rev-' + Date.now();
    const review: HypothesisReview = {
      id: 'r-' + Date.now(), hypothesisId: hid, criticAdapter: 'fake', criticModel: 'fake',
      verdict: 'ok', concerns: [], summary: 's', createdAt: new Date().toISOString(),
    };
    await reviews.create(review);
    expect((await reviews.listByHypothesis(hid)).length).toBe(1);
  });
});
