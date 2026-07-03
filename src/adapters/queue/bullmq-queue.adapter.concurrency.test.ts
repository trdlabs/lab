import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BullMqQueueAdapter } from './bullmq-queue.adapter.ts';

const workerCtor = vi.fn();
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: vi.fn(), close: vi.fn() })),
  Worker: vi.fn().mockImplementation((...args: unknown[]) => {
    workerCtor(...args);
    return { close: vi.fn() };
  }),
}));

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
