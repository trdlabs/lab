import { and, asc, eq, inArray, notInArray } from 'drizzle-orm';
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
    availableAt: row.availableAt ? row.availableAt.toISOString() : undefined,
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
      availableAt: task.availableAt ? new Date(task.availableAt) : null,
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

  async startRunUnlessTerminal(id: string): Promise<boolean> {
    // Atomic TERMINAL fence (P1-3): one conditional UPDATE that transitions to 'running' unless the
    // row is already terminal. This guarantees a completed/rejected task is never re-run; it does NOT
    // serialize two concurrent non-terminal deliveries (both pass running->running) — that needs a
    // lease token, a separate follow-up.
    const updated = await this.db
      .update(researchTask)
      .set({ status: 'running', updatedAt: new Date() })
      .where(and(eq(researchTask.id, id), notInArray(researchTask.status, ['completed', 'rejected'])))
      .returning({ id: researchTask.id });
    if (updated.length > 0) return true;
    // 0 rows: the task is either terminal (a no-op → false) or absent (→ throw), same contract as
    // updateStatus. One extra read, only on the rare no-transition path.
    const exists = await this.db.select({ id: researchTask.id }).from(researchTask).where(eq(researchTask.id, id)).limit(1);
    if (exists.length === 0) throw new Error(`research_task not found: ${id}`);
    return false;
  }

  async listByCorrelationAndTypes(correlationId: string, taskTypes: AgentTaskType[]): Promise<ResearchTask[]> {
    if (taskTypes.length === 0) return [];
    const rows = await this.db.select().from(researchTask).where(
      and(eq(researchTask.correlationId, correlationId), inArray(researchTask.taskType, taskTypes)),
    );
    return rows.map(toDomain);
  }

  async listQueued(): Promise<ResearchTask[]> {
    const rows = await this.db
      .select()
      .from(researchTask)
      .where(eq(researchTask.status, 'queued'))
      .orderBy(asc(researchTask.createdAt), asc(researchTask.id));
    return rows.map(toDomain);
  }
}
