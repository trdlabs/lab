import { randomUUID } from 'node:crypto';
import type { AgentTaskType, QueueEnvelope, ResearchTask, TaskSource, TaskStatus } from '../domain/types.ts';
import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';
import type { TaskQueuePort } from '../ports/task-queue.port.ts';

export interface TaskIntakeInput {
  taskType: AgentTaskType;
  source: TaskSource;
  payload: Record<string, unknown>;
  correlationId?: string;
  dedupeKey?: string;
  /** BullMQ delayed job; in-memory adapter ignores it (test-time immediacy). */
  delayMs?: number;
}

export interface TaskIntakeDeps {
  repo: ResearchTaskRepository;
  queue: TaskQueuePort;
}

export interface TaskIntakeResult {
  taskId: string;
  status: TaskStatus;
  deduped: boolean;
}

/**
 * The single deterministic chokepoint for creating + enqueuing a ResearchTask.
 * POST /tasks, POST /chat/messages, and the auto-chain runner all go through here.
 */
export async function createAndEnqueueTask(
  input: TaskIntakeInput,
  deps: TaskIntakeDeps,
): Promise<TaskIntakeResult> {
  if (input.dedupeKey) {
    const existing = await deps.repo.findByDedupeKey(input.dedupeKey);
    if (existing) return { taskId: existing.id, status: existing.status, deduped: true };
  }

  const now = new Date().toISOString();
  const task: ResearchTask = {
    id: randomUUID(),
    taskType: input.taskType,
    source: input.source,
    correlationId: input.correlationId ?? randomUUID(),
    dedupeKey: input.dedupeKey,
    status: 'queued',
    payload: input.payload,
    createdAt: now,
    updatedAt: now,
  };
  await deps.repo.create(task);

  const envelope: QueueEnvelope = {
    taskId: task.id,
    taskType: task.taskType,
    correlationId: task.correlationId,
    source: task.source,
    attempt: 1,
    dedupeKey: task.dedupeKey,
  };
  await deps.queue.enqueue(envelope, input.delayMs !== undefined ? { delayMs: input.delayMs } : undefined);

  return { taskId: task.id, status: task.status, deduped: false };
}
