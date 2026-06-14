import { describe, it, expect } from 'vitest';
import { createIngressApp } from '../../src/ingress/app.ts';
import { startWorker } from '../../src/worker/worker.ts';
import { InMemoryQueueAdapter } from '../../src/adapters/queue/in-memory-queue.adapter.ts';
import { WorkflowRouter } from '../../src/orchestrator/workflow-router.ts';
import { researchRunCycleHandler } from '../../src/orchestrator/handlers/research-run-cycle.handler.ts';
import { makeServices } from '../support/make-services.ts';
import type { StrategyProfile } from '../../src/domain/strategy-profile.ts';

function profile(): StrategyProfile {
  return {
    id: 'p-e2e', version: 1, sourceKind: 'manual_description', sourceFingerprint: 'sha256:e2e',
    direction: 'long', coreIdea: 'Long OI divergence', requiredMarketFeatures: ['oi'],
    confidence: 0.5, unknowns: [], profile: {} as never, sourceArtifactRef: {} as never,
    contractVersion: 'strategy-profile-v1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('E2E: research.run_cycle ingress -> worker -> persisted hypotheses', () => {
  it('drives a run-cycle task from POST to persisted hypotheses', async () => {
    const queue = new InMemoryQueueAdapter();
    const services = makeServices();
    await services.strategyProfiles.create(profile());

    const router = new WorkflowRouter();
    router.register('research.run_cycle', researchRunCycleHandler);
    startWorker({ queue, router, services });

    const app = createIngressApp({ repo: services.researchTasks, queue, taskToken: 'e2e-task-token' });
    const res = await app.request('/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer e2e-task-token' },
      body: JSON.stringify({ taskType: 'research.run_cycle', source: 'operator', payload: { strategyProfileId: 'p-e2e' } }),
    });
    expect(res.status).toBe(202);
    const { taskId } = (await res.json()) as { taskId: string };

    await queue.drain();

    expect((await services.researchTasks.findById(taskId))?.status).toBe('completed');
    const stored = await services.hypotheses.listByStrategyProfile('p-e2e');
    expect(stored.length).toBe(2); // FakeResearcher emits two validated hypotheses
    expect(stored.every((h) => h.status === 'validated')).toBe(true);

    const events = (await services.events.listByTask(taskId)).map((e) => e.type);
    expect(events[0]).toBe('research.run_cycle.started');
    expect(events.at(-1)).toBe('research.run_cycle.completed');
  });
});
