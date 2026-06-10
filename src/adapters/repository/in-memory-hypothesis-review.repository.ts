import type { HypothesisReview } from '../../domain/critic.ts';
import type { HypothesisReviewRepository } from '../../ports/hypothesis-review.repository.ts';

export class InMemoryHypothesisReviewRepository implements HypothesisReviewRepository {
  private readonly byId = new Map<string, HypothesisReview>();

  async create(review: HypothesisReview): Promise<void> {
    if (this.byId.has(review.id)) throw new Error(`hypothesis_review already exists: ${review.id}`);
    this.byId.set(review.id, { ...review });
  }

  async listByHypothesis(hypothesisId: string): Promise<HypothesisReview[]> {
    return [...this.byId.values()].filter((r) => r.hypothesisId === hypothesisId);
  }
}
