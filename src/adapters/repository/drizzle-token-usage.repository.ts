import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { researchTokenUsage } from '../../db/schema.ts';
import type { TokenUsageRepository } from '../../ports/token-usage.repository.ts';

export class DrizzleTokenUsageRepository implements TokenUsageRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async add(correlationId: string, tokens: number): Promise<void> {
    await this.db
      .insert(researchTokenUsage)
      .values({ correlationId, cumulativeTokens: tokens, cumulativeCostUsd: 0, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: researchTokenUsage.correlationId,
        set: {
          cumulativeTokens: sql`${researchTokenUsage.cumulativeTokens} + ${tokens}`,
          updatedAt: new Date(),
        },
      });
  }

  async get(correlationId: string): Promise<number> {
    const rows = await this.db
      .select({ total: researchTokenUsage.cumulativeTokens })
      .from(researchTokenUsage)
      .where(eq(researchTokenUsage.correlationId, correlationId))
      .limit(1);
    return rows[0]?.total ?? 0;
  }

  async addCost(correlationId: string, costUsd: number): Promise<void> {
    await this.db
      .insert(researchTokenUsage)
      .values({ correlationId, cumulativeCostUsd: costUsd, cumulativeTokens: 0, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: researchTokenUsage.correlationId,
        set: {
          cumulativeCostUsd: sql`${researchTokenUsage.cumulativeCostUsd} + ${costUsd}`,
          updatedAt: new Date(),
        },
      });
  }

  async getCost(correlationId: string): Promise<number> {
    const rows = await this.db
      .select({ total: researchTokenUsage.cumulativeCostUsd })
      .from(researchTokenUsage)
      .where(eq(researchTokenUsage.correlationId, correlationId))
      .limit(1);
    return rows[0]?.total ?? 0;
  }
}
