import { describe, it, expect } from 'vitest';
import { startWorker } from './worker.ts';
import { InMemoryQueueAdapter } from '../adapters/queue/in-memory-queue.adapter.ts';
import { WorkflowRouter } from '../orchestrator/workflow-router.ts';
import { echoHandler } from '../orchestrator/handlers/echo.handler.ts';
import { makeServices } from '../../test/support/make-services.ts';
import type { QueueEnvelope, ResearchTask } from '../domain/types.ts';

const task = (over: Partial<ResearchTask> = {}): ResearchTask => ({
  id: 'id-1', taskType: 'strategy.onboard', source: 'web', correlationId: 'c1',
  status: 'queued', payload: {}, createdAt: '2026-06-10T00:00:00Z', updatedAt: '2026-06-10T00:00:00Z', ...over,
});
const env = (over: Partial<QueueEnvelope> = {}): QueueEnvelope => ({
  taskId: 'id-1', taskType: 'strategy.onboard', correlationId: 'c1', source: 'web', attempt: 1, ...over,
});

describe('startWorker', () => {
  it('marks task running then completed on success', async () => {
    const queue = new InMemoryQueueAdapter();
    const services = makeServices();
    await services.researchTasks.create(task());
    const router = new WorkflowRouter();
    router.register('strategy.onboard', echoHandler);
    startWorker({ queue, router, services });
    await queue.enqueue(env());
    await queue.drain();
    expect((await services.researchTasks.findById('id-1'))?.status).toBe('completed');
  });

  it('does NOT re-dispatch a redelivered task that is already completed (P1-3 idempotency fence)', async () => {
    const queue = new InMemoryQueueAdapter();
    const services = makeServices();
    await services.researchTasks.create(task({ status: 'completed' }));
    let calls = 0;
    const router = new WorkflowRouter();
    router.register('strategy.onboard', async () => { calls += 1; });
    startWorker({ queue, router, services });
    await queue.enqueue(env());
    await queue.drain();
    expect(calls).toBe(0); // handler never re-ran
    expect((await services.researchTasks.findById('id-1'))?.status).toBe('completed'); // unchanged
  });

  it('skips a redelivered rejected task without re-dispatching', async () => {
    const queue = new InMemoryQueueAdapter();
    const services = makeServices();
    await services.researchTasks.create(task({ status: 'rejected' }));
    let calls = 0;
    const router = new WorkflowRouter();
    router.register('strategy.onboard', async () => { calls += 1; });
    startWorker({ queue, router, services });
    await queue.enqueue(env());
    await queue.drain();
    expect(calls).toBe(0);
    expect((await services.researchTasks.findById('id-1'))?.status).toBe('rejected');
  });

  it('marks task failed when the handler throws', async () => {
    const queue = new InMemoryQueueAdapter();
    const services = makeServices();
    await services.researchTasks.create(task());
    const router = new WorkflowRouter();
    router.register('strategy.onboard', async () => { throw new Error('boom'); });
    startWorker({ queue, router, services });
    await queue.enqueue(env());
    await expect(queue.drain()).rejects.toThrow('boom');
    expect((await services.researchTasks.findById('id-1'))?.status).toBe('failed');
  });

  it('rethrows the original handler error even if recording failed status throws', async () => {
    const queue = new InMemoryQueueAdapter();
    const base = makeServices();
    await base.researchTasks.create(task());
    const researchTasks = {
      findById: (id: string) => base.researchTasks.findById(id),
      findByDedupeKey: (k: string) => base.researchTasks.findByDedupeKey(k),
      create: (t: ResearchTask) => base.researchTasks.create(t),
      updateStatus: async (id: string, status: ResearchTask['status']) => {
        if (status === 'failed') throw new Error('db down');
        return base.researchTasks.updateStatus(id, status);
      },
      listByCorrelationAndTypes: (correlationId: string, taskTypes: ResearchTask['taskType'][]) =>
        base.researchTasks.listByCorrelationAndTypes(correlationId, taskTypes),
      tryStartRun: (id: string) => base.researchTasks.tryStartRun(id),
    };
    const services = { ...base, researchTasks };
    const router = new WorkflowRouter();
    router.register('strategy.onboard', async () => { throw new Error('boom'); });
    startWorker({ queue, router, services });
    await queue.enqueue(env());
    await expect(queue.drain()).rejects.toThrow('boom');
  });
});
