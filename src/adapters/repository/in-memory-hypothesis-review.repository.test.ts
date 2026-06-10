import { describe, it, expect } from 'vitest';
import { InMemoryHypothesisReviewRepository } from './in-memory-hypothesis-review.repository.ts';
import type { HypothesisReview } from '../../domain/critic.ts';

function review(id: string, hypothesisId: string): HypothesisReview {
  return {
    id, hypothesisId, criticAdapter: 'fake', criticModel: 'fake',
    verdict: 'ok', concerns: [], summary: 's', createdAt: '2026-01-01T00:00:00Z',
  };
}

describe('InMemoryHypothesisReviewRepository', () => {
  it('creates and lists by hypothesis in insertion order', async () => {
    const repo = new InMemoryHypothesisReviewRepository();
    await repo.create(review('r1', 'h1'));
    await repo.create(review('r2', 'h2'));
    await repo.create(review('r3', 'h1'));
    expect((await repo.listByHypothesis('h1')).map((r) => r.id)).toEqual(['r1', 'r3']);
  });

  it('throws on duplicate id', async () => {
    const repo = new InMemoryHypothesisReviewRepository();
    await repo.create(review('r1', 'h1'));
    await expect(repo.create(review('r1', 'h1'))).rejects.toThrow();
  });
});
