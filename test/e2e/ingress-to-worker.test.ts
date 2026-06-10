import { describe, it, expect } from 'vitest';
import { createIngressApp } from '../../src/ingress/app.ts';
import { startWorker } from '../../src/worker/worker.ts';
import { InMemoryQueueAdapter } from '../../src/adapters/queue/in-memory-queue.adapter.ts';
import { WorkflowRouter } from '../../src/orchestrator/workflow-router.ts';
import { echoHandler } from '../../src/orchestrator/handlers/echo.handler.ts';
import { makeServices } from '../support/make-services.ts';

describe('E2E: Ingress → queue → worker → router', () => {
  it('drives a task from POST to completed', async () => {
    const queue = new InMemoryQueueAdapter();
    const services = makeServices();
    const router = new WorkflowRouter();
    router.register('strategy.onboard', echoHandler);
    startWorker({ queue, router, services });

    const app = createIngressApp({ repo: services.researchTasks, queue });
    const res = await app.request('/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskType: 'strategy.onboard', source: 'web', payload: { url: 'x' } }),
    });
    const { taskId } = (await res.json()) as { taskId: string };
    expect((await services.researchTasks.findById(taskId))?.status).toBe('queued');

    await queue.drain();
    expect((await services.researchTasks.findById(taskId))?.status).toBe('completed');
    expect(queue.queued).toHaveLength(0);
  });
});
