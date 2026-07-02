import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BullMqQueueAdapter, toBullmqJobId } from './bullmq-queue.adapter.ts';
import type { QueueEnvelope } from '../../domain/types.ts';

const workerCtor = vi.fn();
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: vi.fn(), close: vi.fn() })),
  Worker: vi.fn().mockImplementation((...args: unknown[]) => {
    workerCtor(...args);
    return { close: vi.fn() };
  }),
}));

// Pure unit — runs in CI without Redis (the integration block below is gated on REDIS_URL).
describe('toBullmqJobId', () => {
  it('replaces ":" (forbidden in BullMQ custom ids) so chat-proposal dedupeKeys are legal', () => {
    // Chat proposals build dedupeKey `chat-proposal:<id>`; BullMQ rejects ":" in a custom job id,
    // which crashed confirm -> enqueue with a 500 until this sanitization was added.
    expect(toBullmqJobId('chat-proposal:p1')).toBe('chat-proposal_p1');
  });
  it('leaves a colon-free id (e.g. a task UUID) untouched', () => {
    expect(toBullmqJobId('7202dc09-7083-4d54-8b59-483133e59461')).toBe('7202dc09-7083-4d54-8b59-483133e59461');
  });
  it('never returns a value containing ":"', () => {
    expect(toBullmqJobId('a:b:c')).not.toContain(':');
  });
});

describe('BullMqQueueAdapter worker concurrency', () => {
  beforeEach(() => { workerCtor.mockClear(); });

  it('defaults Worker concurrency to 1', () => {
    const a = new BullMqQueueAdapter('redis://localhost:6379');
    a.process(async () => {});
    const opts = workerCtor.mock.calls[0]?.[2] as { concurrency?: number };
    expect(opts.concurrency).toBe(1);
  });

  it('passes workerConcurrency through to the Worker options', () => {
    const a = new BullMqQueueAdapter('redis://localhost:6379', 'research-tasks', { workerConcurrency: 4 });
    a.process(async () => {});
    const opts = workerCtor.mock.calls[0]?.[2] as { concurrency?: number };
    expect(opts.concurrency).toBe(4);
  });

  it('rejects a non-positive or non-integer workerConcurrency', () => {
    expect(() => new BullMqQueueAdapter('redis://localhost:6379', 'research-tasks', { workerConcurrency: 0 }))
      .toThrow(/positive integer/);
    expect(() => new BullMqQueueAdapter('redis://localhost:6379', 'research-tasks', { workerConcurrency: 1.5 }))
      .toThrow(/positive integer/);
  });
});

const redisUrl = process.env.REDIS_URL;
const d = redisUrl ? describe : describe.skip;

const env = (over: Partial<QueueEnvelope> = {}): QueueEnvelope => ({
  taskId: 't1', taskType: 'strategy.onboard', correlationId: 'c1', source: 'web', attempt: 1, ...over,
});

d('BullMqQueueAdapter (integration)', () => {
  it('delivers an enqueued envelope to the worker', async () => {
    const a = new BullMqQueueAdapter(redisUrl!, `test-${Date.now()}`);
    const received = new Promise<QueueEnvelope>((resolve) => {
      a.process(async (e) => { resolve(e); });
    });
    await a.enqueue(env({ taskId: 'x', dedupeKey: 'dk-1' }));
    const got = await received;
    expect(got.taskId).toBe('x');
    await a.close();
  });
});
