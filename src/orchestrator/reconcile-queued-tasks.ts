import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';
import type { TaskQueuePort } from '../ports/task-queue.port.ts';
import { toQueueEnvelope } from './task-intake.ts';

export interface ReconcileDeps {
  repo: Pick<ResearchTaskRepository, 'listQueued'>;
  queue: TaskQueuePort;
  /** Injectable clock (ms). Default Date.now. */
  now?: () => number;
}

/** Remaining delay for a stranded row. null/undefined availableAt => immediate (0). A non-empty
 *  but unparseable value is a data error and throws — never coerce NaN into an implicit immediate. */
function remainingDelayMs(availableAt: string | undefined, nowMs: number): number {
  if (availableAt === undefined || availableAt === null) return 0;
  const t = Date.parse(availableAt);
  if (Number.isNaN(t)) throw new Error(`research_task.availableAt is not a valid ISO timestamp: ${JSON.stringify(availableAt)}`);
  return Math.max(0, t - nowMs);
}

/**
 * Boot-time reconciliation (P1-1): re-enqueue every `queued` row so a job stranded by a crash
 * between DB-create and enqueue is restored. The queue adapter dedupes by jobId (dedupeKey ??
 * taskId), so an already-active job is a no-op and a lost one is recreated. Returns attempted /
 * reEnqueued counts (NOT "restored": without queue inspection a live job is indistinguishable from
 * a lost one). Any enqueue error propagates — the caller MUST abort startup rather than run with
 * partial reconciliation.
 */
export async function reconcileQueuedTasks(deps: ReconcileDeps): Promise<{ attempted: number; reEnqueued: number }> {
  const nowMs = (deps.now ?? Date.now)();
  let attempted = 0;
  let reEnqueued = 0;
  for (const task of await deps.repo.listQueued()) {
    attempted += 1;
    const delayMs = remainingDelayMs(task.availableAt, nowMs);
    await deps.queue.enqueue(toQueueEnvelope(task), delayMs > 0 ? { delayMs } : undefined);
    reEnqueued += 1;
  }
  return { attempted, reEnqueued };
}
