import { eq, and, or, gt, gte, asc, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { agentEvent, researchTask } from '../../db/schema.ts';
import type { AgentEventReadPort, AgentEventListQuery, AgentEventRow } from '../../ports/agent-event-read.port.ts';

export class DrizzleAgentEventReadAdapter implements AgentEventReadPort {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async list(q: AgentEventListQuery): Promise<AgentEventRow[]> {
    const conds: SQL[] = [];
    if (q.taskId) conds.push(eq(agentEvent.taskId, q.taskId));
    if (q.type) conds.push(eq(agentEvent.type, q.type));
    if (q.since) conds.push(gte(agentEvent.createdAt, new Date(q.since)));
    if (q.correlationId) conds.push(eq(researchTask.correlationId, q.correlationId));
    if (q.after) {
      const d = new Date(q.after.t);
      conds.push(or(gt(agentEvent.createdAt, d), and(eq(agentEvent.createdAt, d), gt(agentEvent.id, q.after.id)))!);
    }
    const rows = await this.db
      .select({
        id: agentEvent.id, taskId: agentEvent.taskId, type: agentEvent.type,
        payload: agentEvent.payload, createdAt: agentEvent.createdAt,
        correlationId: researchTask.correlationId,
      })
      .from(agentEvent)
      .leftJoin(researchTask, eq(agentEvent.taskId, researchTask.id))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(agentEvent.createdAt), asc(agentEvent.id))
      .limit(q.limit);

    return rows.map((r) => ({
      id: r.id, taskId: r.taskId, type: r.type,
      payload: r.payload as Record<string, unknown>,
      createdAt: r.createdAt.toISOString(),
      ...(r.correlationId ? { correlationId: r.correlationId } : {}),
    }));
  }
}
