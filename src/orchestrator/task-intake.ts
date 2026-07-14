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
  /** Injectable clock (ms). One value stamps createdAt/updatedAt AND availableAt. Default Date.now. */
  now?: () => number;
}

export interface TaskIntakeResult {
  taskId: string;
  status: TaskStatus;
  deduped: boolean;
}

/** Build the queue transport envelope for a task row. Carries dedupeKey so the BullMQ jobId
 *  (dedupeKey ?? taskId) is stable — the basis of enqueue idempotency (P1-1). */
export function toQueueEnvelope(task: ResearchTask): QueueEnvelope {
  return {
    taskId: task.id,
    taskType: task.taskType,
    correlationId: task.correlationId,
    source: task.source,
    attempt: 1,
    dedupeKey: task.dedupeKey,
  };
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

  const nowMs = (deps.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();
  const task: ResearchTask = {
    id: randomUUID(),
    taskType: input.taskType,
    source: input.source,
    correlationId: input.correlationId ?? randomUUID(),
    dedupeKey: input.dedupeKey,
    status: 'queued',
    payload: input.payload,
    availableAt: new Date(nowMs + (input.delayMs ?? 0)).toISOString(),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  await deps.repo.create(task);

  await deps.queue.enqueue(toQueueEnvelope(task), input.delayMs !== undefined ? { delayMs: input.delayMs } : undefined);

  return { taskId: task.id, status: task.status, deduped: false };
}
