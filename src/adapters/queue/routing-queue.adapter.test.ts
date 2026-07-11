// src/adapters/queue/routing-queue.adapter.test.ts
import { describe, it, expect } from 'vitest';
import type { TaskQueuePort, QueueHandler } from '../../ports/task-queue.port.ts';
import type { QueueEnvelope } from '../../domain/types.ts';
import {
  RoutingQueueAdapter, buildQueueLanes, DEFAULT_QUEUE_NAME, REVISION_QUEUE_NAME,
} from './routing-queue.adapter.ts';

function fakeQueue(): TaskQueuePort & {
  enqueued: Array<{ envelope: QueueEnvelope; opts?: { delayMs?: number } }>;
  processed: number; closed: number; closeError?: Error;
} {
  const state = {
    enqueued: [] as Array<{ envelope: QueueEnvelope; opts?: { delayMs?: number } }>,
    processed: 0,
    closed: 0,
    closeError: undefined as Error | undefined,
    async enqueue(envelope: QueueEnvelope, opts?: { delayMs?: number }) { state.enqueued.push({ envelope, opts }); },
    process(_handler: QueueHandler) { state.processed += 1; },
    async close() { state.closed += 1; if (state.closeError) throw state.closeError; },
  };
  return state;
}

function envelope(taskType: string): QueueEnvelope {
  return { taskId: 't1', taskType: taskType as QueueEnvelope['taskType'], correlationId: 'c1', source: 'web', attempt: 1 };
}

describe('RoutingQueueAdapter', () => {
  it('enqueues revision.* on the revision lane, everything else on default, passing delayMs through', async () => {
    const def = fakeQueue(); const rev = fakeQueue();
    const adapter = new RoutingQueueAdapter({ default: def, revision: rev });

    await adapter.enqueue(envelope('hypothesis.build'), { delayMs: 500 });
    await adapter.enqueue(envelope('revision.build'));

    expect(def.enqueued).toHaveLength(1);
    const firstDefault = def.enqueued[0]!;
    expect(firstDefault.envelope.taskType).toBe('hypothesis.build');
    expect(firstDefault.opts).toEqual({ delayMs: 500 });
    expect(rev.enqueued).toHaveLength(1);
    const firstRevision = rev.enqueued[0]!;
    expect(firstRevision.envelope.taskType).toBe('revision.build');
  });

  it('registers the handler on every lane', () => {
    const def = fakeQueue(); const rev = fakeQueue();
    const adapter = new RoutingQueueAdapter({ default: def, revision: rev });
    adapter.process(async () => {});
    expect(def.processed).toBe(1);
    expect(rev.processed).toBe(1);
  });

  it('closes ALL lanes even when one fails, then throws AggregateError (no short-circuit)', async () => {
    const def = fakeQueue(); const rev = fakeQueue();
    rev.closeError = new Error('revision boom');
    const adapter = new RoutingQueueAdapter({ default: def, revision: rev });
    await expect(adapter.close()).rejects.toThrow(AggregateError);
    expect(def.closed).toBe(1);
    expect(rev.closed).toBe(1);
  });

  it('closes all lanes cleanly when none fail', async () => {
    const def = fakeQueue(); const rev = fakeQueue();
    const adapter = new RoutingQueueAdapter({ default: def, revision: rev });
    await expect(adapter.close()).resolves.toBeUndefined();
  });
});

describe('buildQueueLanes', () => {
  it('builds the revision lane at the given concurrency and the default lane from env (config-assert, no BullMQ)', () => {
    const calls: Array<{ name: string; conc: number }> = [];
    buildQueueLanes({
      defaultConcurrency: 3,
      revisionConcurrency: 1,
      createLaneAdapter: (name, conc) => { calls.push({ name, conc }); return fakeQueue(); },
    });
    expect(calls).toContainEqual({ name: REVISION_QUEUE_NAME, conc: 1 });
    expect(calls).toContainEqual({ name: DEFAULT_QUEUE_NAME, conc: 3 });
    expect(REVISION_QUEUE_NAME).toBe('research-tasks-revision');
    expect(DEFAULT_QUEUE_NAME).toBe('research-tasks');
  });
});
