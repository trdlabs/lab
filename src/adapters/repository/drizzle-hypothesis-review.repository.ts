import { eq, asc } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { hypothesisReview } from '../../db/schema.ts';
import type { HypothesisReview, CriticConcern } from '../../domain/critic.ts';
import type { HypothesisReviewRepository } from '../../ports/hypothesis-review.repository.ts';

type Row = typeof hypothesisReview.$inferSelect;

function toDomain(row: Row): HypothesisReview {
  return {
    id: row.id,
    hypothesisId: row.hypothesisId,
    criticAdapter: row.criticAdapter,
    criticModel: row.criticModel,
    verdict: row.verdict as 'ok' | 'concerns',
    concerns: row.concerns as CriticConcern[],
    summary: row.summary,
    createdAt: row.createdAt.toISOString(),
  };
}

export class DrizzleHypothesisReviewRepository implements HypothesisReviewRepository {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async create(review: HypothesisReview): Promise<void> {
    await this.db.insert(hypothesisReview).values({
      id: review.id, hypothesisId: review.hypothesisId, criticAdapter: review.criticAdapter,
      criticModel: review.criticModel, verdict: review.verdict, concerns: review.concerns,
      summary: review.summary, createdAt: new Date(review.createdAt),
    });
  }

  async listByHypothesis(hypothesisId: string): Promise<HypothesisReview[]> {
    const rows = await this.db
      .select().from(hypothesisReview)
      .where(eq(hypothesisReview.hypothesisId, hypothesisId))
      .orderBy(asc(hypothesisReview.createdAt));
    return rows.map(toDomain);
  }
}
