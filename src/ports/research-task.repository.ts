import type { AgentTaskType, ResearchTask, TaskStatus } from '../domain/types.ts';

export interface ResearchTaskRepository {
  create(task: ResearchTask): Promise<void>;
  findById(id: string): Promise<ResearchTask | null>;
  findByDedupeKey(dedupeKey: string): Promise<ResearchTask | null>;
  updateStatus(id: string, status: TaskStatus): Promise<void>;
  /**
   * Atomic TERMINAL fence: set status='running' iff the task is NOT already terminal
   * (completed | rejected). Returns true when it transitioned, false when it was terminal (a
   * redelivery of finished work). Guarantees ONLY that a completed/rejected task never re-runs its
   * handler (P1-3). It does NOT provide mutual exclusion between two concurrent non-terminal
   * deliveries: both would pass the fence (running -> running) and dispatch. Single-flight for
   * concurrent delivery needs an owner/lease token — a separate follow-up before raising concurrency.
   */
  startRunUnlessTerminal(id: string): Promise<boolean>;
  /** All tasks in a correlation chain whose taskType is one of the given types. */
  listByCorrelationAndTypes(correlationId: string, taskTypes: AgentTaskType[]): Promise<ResearchTask[]>;
  /** All rows with status 'queued', ordered by (createdAt, id). The boot sweeper's read (P1-1). */
  listQueued(): Promise<ResearchTask[]>;
}
