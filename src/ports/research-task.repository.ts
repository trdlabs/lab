import type { AgentTaskType, ResearchTask, TaskStatus } from '../domain/types.ts';

export interface ResearchTaskRepository {
  create(task: ResearchTask): Promise<void>;
  findById(id: string): Promise<ResearchTask | null>;
  findByDedupeKey(dedupeKey: string): Promise<ResearchTask | null>;
  updateStatus(id: string, status: TaskStatus): Promise<void>;
  /**
   * Atomically claim a task for execution: set status='running' iff it is NOT already terminal
   * (completed | rejected). Returns true when the row was claimed, false when it was already
   * terminal (a redelivery of finished work). This is the worker's idempotency fence + claim in one
   * step, so a stalled redelivery never re-runs a completed handler (P1-3).
   */
  tryStartRun(id: string): Promise<boolean>;
  /** All tasks in a correlation chain whose taskType is one of the given types. */
  listByCorrelationAndTypes(correlationId: string, taskTypes: AgentTaskType[]): Promise<ResearchTask[]>;
}
