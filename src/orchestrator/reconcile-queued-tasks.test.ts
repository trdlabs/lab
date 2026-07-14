import { describe, it, expect } from 'vitest';
import { reconcileQueuedTasks } from './reconcile-queued-tasks.ts';
import type { ResearchTask, QueueEnvelope } from '../domain/types.ts';
import type { TaskQueuePort } from '../ports/task-queue.port.ts';

const task = (over: Partial<ResearchTask>): ResearchTask => ({
  id: 'id', taskType: 'strategy.onboard', source: 'web', correlationId: 'c1',
  status: 'queued', payload: {}, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...over,
});

// Records enqueue calls AND models BullMQ jobId identity (dedupeKey ?? taskId) so "already active"
// collapses to a single job — the stock InMemoryQueueAdapter can't (it dedupes on dedupeKey only
// and ignores delayMs).
class RecordingQueue implements TaskQueuePort {
  readonly calls: { envelope: QueueEnvelope; opts?: { delayMs?: number } }[] = [];
  private readonly jobs = new Set<string>();
  async enqueue(envelope: QueueEnvelope, opts?: { delayMs?: number }): Promise<void> {
    this.calls.push({ envelope, opts });
    this.jobs.add(envelope.dedupeKey ?? envelope.taskId);
  }
  get jobCount(): number { return this.jobs.size; }
  process(): void {}
  async close(): Promise<void> {}
}

const repoOf = (rows: ResearchTask[]) => ({ listQueued: async () => rows });
const NOW = () => Date.parse('2026-07-14T00:00:00.000Z');

describe('reconcileQueuedTasks (P1-1)', () => {
  it('re-enqueues an immediate orphan with no delay', async () => {
    const queue = new RecordingQueue();
    const res = await reconcileQueuedTasks({ repo: repoOf([task({ id: 'o1' })]), queue, now: NOW });
    expect(res).toEqual({ attempted: 1, reEnqueued: 1 });
    expect(queue.calls).toHaveLength(1);
    expect(queue.calls[0]?.envelope.taskId).toBe('o1');
    expect(queue.calls[0]?.opts).toBeUndefined(); // no delayMs
  });

  it('re-enqueues a delayed orphan with the REMAINING delay', async () => {
    const queue = new RecordingQueue();
    await reconcileQueuedTasks({ repo: repoOf([task({ id: 'd1', availableAt: '2026-07-14T00:00:05.000Z' })]), queue, now: NOW });
    expect(queue.calls[0]?.opts).toEqual({ delayMs: 5000 });
  });

  it('past availableAt clamps to no delay', async () => {
    const queue = new RecordingQueue();
    await reconcileQueuedTasks({ repo: repoOf([task({ id: 'p1', availableAt: '2026-07-13T00:00:00.000Z' })]), queue, now: NOW });
    expect(queue.calls[0]?.opts).toBeUndefined();
  });

  it('an already-active job (with dedupeKey) collapses to a single job', async () => {
    const queue = new RecordingQueue();
    const row = task({ id: 'a1', dedupeKey: 'chat-proposal:p1' });
    await queue.enqueue({ taskId: 'a1', taskType: 'strategy.onboard', correlationId: 'c1', source: 'web', attempt: 1, dedupeKey: 'chat-proposal:p1' }); // job already active
    await reconcileQueuedTasks({ repo: repoOf([row]), queue, now: NOW });
    expect(queue.jobCount).toBe(1); // sweeper still enqueued; jobId identity keeps it one
  });

  it('an already-active keyless job collapses via taskId identity', async () => {
    const queue = new RecordingQueue();
    const row = task({ id: 'k1', dedupeKey: undefined });
    await queue.enqueue({ taskId: 'k1', taskType: 'strategy.onboard', correlationId: 'c1', source: 'web', attempt: 1, dedupeKey: undefined });
    await reconcileQueuedTasks({ repo: repoOf([row]), queue, now: NOW });
    expect(queue.jobCount).toBe(1);
  });

  it('throws on a non-empty but unparseable availableAt (data error, not implicit immediate)', async () => {
    const queue = new RecordingQueue();
    await expect(reconcileQueuedTasks({ repo: repoOf([task({ id: 'bad', availableAt: 'not-a-date' })]), queue, now: NOW }))
      .rejects.toThrow(/availableAt/i);
  });

  it('fails fast when enqueue throws (startup must abort)', async () => {
    const queue = { async enqueue() { throw new Error('redis down'); }, process() {}, async close() {} } as unknown as TaskQueuePort;
    await expect(reconcileQueuedTasks({ repo: repoOf([task({ id: 'x' })]), queue, now: NOW })).rejects.toThrow('redis down');
  });
});
