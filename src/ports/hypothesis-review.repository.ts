import type { HypothesisReview } from '../domain/critic.ts';

export interface HypothesisReviewRepository {
  create(review: HypothesisReview): Promise<void>;
  listByHypothesis(hypothesisId: string): Promise<HypothesisReview[]>;
}
