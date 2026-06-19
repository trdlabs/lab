import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { chatSession } from '../../db/schema.ts';
import type { ChatSessionContext, ChatSessionRepository } from '../../ports/chat-session.repository.ts';

type Row = typeof chatSession.$inferSelect;

function toDomain(row: Row): ChatSessionContext {
  return {
    sessionId: row.sessionId,
    lastStrategyProfileId: row.lastStrategyProfileId ?? undefined,
    lastResearchTaskId: row.lastResearchTaskId ?? undefined,
    lastHypothesisId: row.lastHypothesisId ?? undefined,
    lastBacktestRunId: row.lastBacktestRunId ?? undefined,
    lastUserGoal: row.lastUserGoal ?? undefined,
    pendingPlanId: row.pendingPlanId ?? undefined,
    pendingInteraction: row.pendingInteraction ?? undefined,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class DrizzleChatSessionRepository implements ChatSessionRepository {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async get(sessionId: string): Promise<ChatSessionContext | null> {
    const rows = await this.db.select().from(chatSession).where(eq(chatSession.sessionId, sessionId)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async upsert(ctx: ChatSessionContext): Promise<void> {
    const values = {
      sessionId: ctx.sessionId,
      lastStrategyProfileId: ctx.lastStrategyProfileId ?? null,
      lastResearchTaskId: ctx.lastResearchTaskId ?? null,
      lastHypothesisId: ctx.lastHypothesisId ?? null,
      lastBacktestRunId: ctx.lastBacktestRunId ?? null,
      lastUserGoal: ctx.lastUserGoal ?? null,
      pendingPlanId: ctx.pendingPlanId ?? null,
      pendingInteraction: ctx.pendingInteraction ?? null,
      updatedAt: new Date(ctx.updatedAt),
    };
    await this.db.insert(chatSession).values(values).onConflictDoUpdate({
      target: chatSession.sessionId,
      set: {
        lastStrategyProfileId: values.lastStrategyProfileId,
        lastResearchTaskId: values.lastResearchTaskId,
        lastHypothesisId: values.lastHypothesisId,
        lastBacktestRunId: values.lastBacktestRunId,
        lastUserGoal: values.lastUserGoal,
        pendingPlanId: values.pendingPlanId,
        pendingInteraction: values.pendingInteraction,
        updatedAt: values.updatedAt,
      },
    });
  }
}
