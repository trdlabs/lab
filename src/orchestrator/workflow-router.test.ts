import { describe, it, expect } from 'vitest';
import { WorkflowRouter, type HandlerDeps } from './workflow-router.ts';
import { echoHandler } from './handlers/echo.handler.ts';
import { InMemoryResearchTaskRepository } from '../adapters/repository/in-memory-research-task.repository.ts';
import type { ResearchTask } from '../domain/types.ts';

const task = (over: Partial<ResearchTask> = {}): ResearchTask => ({
  id: 'id-1', taskType: 'strategy.onboard', source: 'web', correlationId: 'c1',
  status: 'running', payload: {}, createdAt: '2026-06-10T00:00:00Z', updatedAt: '2026-06-10T00:00:00Z', ...over,
});

describe('WorkflowRouter', () => {
  it('dispatches a task to its registered handler', async () => {
    const repo = new InMemoryResearchTaskRepository();
    const t = task();
    const deps: HandlerDeps = { repo };
    const seen: string[] = [];
    const router = new WorkflowRouter();
    router.register('strategy.onboard', async (task) => { seen.push(task.id); });
    await router.dispatch(t, deps);
    expect(seen).toEqual(['id-1']);
  });

  it('throws on an unregistered task type', async () => {
    const router = new WorkflowRouter();
    const repo = new InMemoryResearchTaskRepository();
    await expect(router.dispatch(task({ taskType: 'paper.monitor' }), { repo })).rejects.toThrow(/no handler/i);
  });
});

describe('echoHandler', () => {
  it('is a no-op stub: it does NOT own the status transition (the worker does)', async () => {
    const repo = new InMemoryResearchTaskRepository();
    const t = task({ status: 'running' });
    await repo.create(t);
    await echoHandler(t, { repo });
    expect((await repo.findById('id-1'))?.status).toBe('running'); // unchanged by the handler
  });
});
