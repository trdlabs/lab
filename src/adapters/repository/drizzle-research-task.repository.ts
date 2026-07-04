import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { researchTask } from '../../db/schema.ts';
import type { AgentTaskType, ResearchTask, TaskStatus } from '../../domain/types.ts';
import type { ResearchTaskRepository } from '../../ports/research-task.repository.ts';

type Row = typeof researchTask.$inferSelect;

function toDomain(row: Row): ResearchTask {
  // Trust boundary: status/taskType/source columns are only ever written via create()
  // with already-typed values, so these casts are safe unless the DB is mutated out-of-band.
  return {
    id: row.id,
    taskType: row.taskType as ResearchTask['taskType'],
    source: row.source as ResearchTask['source'],
    correlationId: row.correlationId,
    dedupeKey: row.dedupeKey ?? undefined,
    status: row.status as TaskStatus,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class DrizzleResearchTaskRepository implements ResearchTaskRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async create(task: ResearchTask): Promise<void> {
    await this.db.insert(researchTask).values({
      id: task.id, taskType: task.taskType, source: task.source,
      correlationId: task.correlationId, dedupeKey: task.dedupeKey ?? null,
      status: task.status, payload: task.payload,
      createdAt: new Date(task.createdAt), updatedAt: new Date(task.updatedAt),
    });
  }

  async findById(id: string): Promise<ResearchTask | null> {
    const rows = await this.db.select().from(researchTask).where(eq(researchTask.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async findByDedupeKey(dedupeKey: string): Promise<ResearchTask | null> {
    const rows = await this.db.select().from(researchTask).where(eq(researchTask.dedupeKey, dedupeKey)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async updateStatus(id: string, status: TaskStatus): Promise<void> {
    const updated = await this.db
      .update(researchTask)
      .set({ status, updatedAt: new Date() })
      .where(eq(researchTask.id, id))
      .returning({ id: researchTask.id });
    if (updated.length === 0) throw new Error(`research_task not found: ${id}`);
  }

  async listByCorrelationAndTypes(correlationId: string, taskTypes: AgentTaskType[]): Promise<ResearchTask[]> {
    if (taskTypes.length === 0) return [];
    const rows = await this.db.select().from(researchTask).where(
      and(eq(researchTask.correlationId, correlationId), inArray(researchTask.taskType, taskTypes)),
    );
    return rows.map(toDomain);
  }
}
