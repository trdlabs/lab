import { describe, it, expect } from 'vitest';
import { WorkflowRouter, type WorkflowHandler } from './workflow-router.ts';
import { echoHandler } from './handlers/echo.handler.ts';
import { makeServices } from '../../test/support/make-services.ts';
import type { ResearchTask } from '../domain/types.ts';

const task = (over: Partial<ResearchTask> = {}): ResearchTask => ({
  id: 'id-1', taskType: 'strategy.onboard', source: 'web', correlationId: 'c1',
  status: 'running', payload: {}, createdAt: '2026-06-10T00:00:00Z', updatedAt: '2026-06-10T00:00:00Z', ...over,
});

describe('WorkflowRouter', () => {
  it('dispatches a task to its registered handler', async () => {
    const services = makeServices();
    const seen: string[] = [];
    const router = new WorkflowRouter();
    router.register('strategy.onboard', async (t) => { seen.push(t.id); });
    await router.dispatch(task(), services);
    expect(seen).toEqual(['id-1']);
  });

  it('throws on an unregistered task type', async () => {
    const router = new WorkflowRouter();
    await expect(router.dispatch(task({ taskType: 'paper.monitor' }), makeServices())).rejects.toThrow(/no handler/i);
  });

  it('throws when the same task type is registered twice', () => {
    const router = new WorkflowRouter();
    const noop: WorkflowHandler = async () => {};
    router.register('strategy.onboard', noop);
    expect(() => router.register('strategy.onboard', noop)).toThrow(/already registered/i);
  });
});

describe('echoHandler', () => {
  it('is a no-op stub: it does NOT own the status transition (the worker does)', async () => {
    const services = makeServices();
    const t = task({ status: 'running' });
    await services.researchTasks.create(t);
    await echoHandler(t, services);
    expect((await services.researchTasks.findById('id-1'))?.status).toBe('running');
  });
});
