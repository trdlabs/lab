import { eq, asc } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { agentEvent } from '../../db/schema.ts';
import type { AgentEvent, AgentEventRepository } from '../../ports/agent-event.repository.ts';

type Row = typeof agentEvent.$inferSelect;

function toDomain(row: Row): AgentEvent {
  return {
    id: row.id,
    taskId: row.taskId,
    type: row.type,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
  };
}

export class DrizzleAgentEventRepository implements AgentEventRepository {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async append(event: AgentEvent): Promise<void> {
    await this.db.insert(agentEvent).values({
      id: event.id, taskId: event.taskId, type: event.type, payload: event.payload,
      createdAt: new Date(event.createdAt),
    });
  }

  async listByTask(taskId: string): Promise<AgentEvent[]> {
    // ORDER BY created_at to match the in-memory adapter's insertion-order contract
    // (an audit log is read chronologically; without this, Postgres row order is undefined).
    const rows = await this.db
      .select()
      .from(agentEvent)
      .where(eq(agentEvent.taskId, taskId))
      .orderBy(asc(agentEvent.createdAt));
    return rows.map(toDomain);
  }
}
