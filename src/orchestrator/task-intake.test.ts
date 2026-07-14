import { describe, it, expect } from 'vitest';
import { createAndEnqueueTask, toQueueEnvelope } from './task-intake.ts';
import { InMemoryResearchTaskRepository } from '../adapters/repository/in-memory-research-task.repository.ts';
import { InMemoryQueueAdapter } from '../adapters/queue/in-memory-queue.adapter.ts';
import type { QueueEnvelope } from '../domain/types.ts';

function setup() {
  const repo = new InMemoryResearchTaskRepository();
  const queue = new InMemoryQueueAdapter();
  return { repo, queue };
}

describe('createAndEnqueueTask', () => {
  it('creates a queued task and enqueues exactly one envelope', async () => {
    const { repo, queue } = setup();
    const r = await createAndEnqueueTask(
      { taskType: 'strategy.onboard', source: 'web', payload: { a: 1 } },
      { repo, queue },
    );
    expect(r.deduped).toBe(false);
    expect(r.status).toBe('queued');
    expect((await repo.findById(r.taskId))?.payload).toEqual({ a: 1 });
    expect(queue.queued).toHaveLength(1);
    expect(queue.queued[0]!.taskId).toBe(r.taskId);
  });

  it('returns the existing task on a dedupeKey hit and does not re-enqueue', async () => {
    const { repo, queue } = setup();
    const input = { taskType: 'strategy.onboard' as const, source: 'web' as const, payload: {}, dedupeKey: 'k1' };
    const first = await createAndEnqueueTask(input, { repo, queue });
    const second = await createAndEnqueueTask(input, { repo, queue });
    expect(second.taskId).toBe(first.taskId);
    expect(second.deduped).toBe(true);
    expect(queue.queued).toHaveLength(1);
  });

  it('uses the provided correlationId on the envelope', async () => {
    const { repo, queue } = setup();
    const r = await createAndEnqueueTask(
      { taskType: 'research.run_cycle', source: 'web', payload: {}, correlationId: 'corr-9' },
      { repo, queue },
    );
    expect(queue.queued[0]!.correlationId).toBe('corr-9');
    expect((await repo.findById(r.taskId))?.correlationId).toBe('corr-9');
  });

  it('passes delayMs through to queue.enqueue opts', async () => {
    const calls: Array<{ envelope: QueueEnvelope; opts?: { delayMs?: number } }> = [];
    const queue = {
      enqueue: async (envelope: QueueEnvelope, opts?: { delayMs?: number }) => {
        calls.push({ envelope, opts });
      },
      process: () => {},
      close: async () => {},
    };
    await createAndEnqueueTask(
      { taskType: 'paper.monitor', source: 'platform', payload: {}, delayMs: 5000 },
      { repo: new InMemoryResearchTaskRepository(), queue },
    );
    expect(calls[0]?.opts).toEqual({ delayMs: 5000 });
  });

  it('omits opts when delayMs is not set (existing behavior)', async () => {
    const calls: Array<{ envelope: QueueEnvelope; opts?: { delayMs?: number } }> = [];
    const queue = {
      enqueue: async (envelope: QueueEnvelope, opts?: { delayMs?: number }) => {
        calls.push({ envelope, opts });
      },
      process: () => {},
      close: async () => {},
    };
    await createAndEnqueueTask(
      { taskType: 'paper.monitor', source: 'platform', payload: {} },
      { repo: new InMemoryResearchTaskRepository(), queue },
    );
    expect(calls[0]?.opts).toBeUndefined();
  });
});

describe('createAndEnqueueTask — availableAt (P1-1)', () => {
  it('stamps availableAt = now + delayMs from a single injected clock', async () => {
    const repo = new InMemoryResearchTaskRepository();
    const queue = new InMemoryQueueAdapter();
    const now = () => Date.parse('2026-07-14T00:00:00.000Z');
    const { taskId } = await createAndEnqueueTask(
      { taskType: 'strategy.onboard', source: 'web', payload: {}, delayMs: 5000 },
      { repo, queue, now },
    );
    const row = await repo.findById(taskId);
    expect(row?.availableAt).toBe('2026-07-14T00:00:05.000Z');
    expect(row?.createdAt).toBe('2026-07-14T00:00:00.000Z');
  });

  it('stamps availableAt = now when no delay', async () => {
    const repo = new InMemoryResearchTaskRepository();
    const queue = new InMemoryQueueAdapter();
    const now = () => Date.parse('2026-07-14T00:00:00.000Z');
    const { taskId } = await createAndEnqueueTask(
      { taskType: 'strategy.onboard', source: 'web', payload: {} },
      { repo, queue, now },
    );
    expect((await repo.findById(taskId))?.availableAt).toBe('2026-07-14T00:00:00.000Z');
  });

  it('toQueueEnvelope preserves dedupeKey (jobId identity)', () => {
    const env = toQueueEnvelope({
      id: 't1', taskType: 'strategy.onboard', source: 'web', correlationId: 'c1',
      dedupeKey: 'chat-proposal:p1', status: 'queued', payload: {},
      createdAt: 'x', updatedAt: 'x',
    });
    expect(env).toEqual({ taskId: 't1', taskType: 'strategy.onboard', correlationId: 'c1', source: 'web', attempt: 1, dedupeKey: 'chat-proposal:p1' });
  });
});
