import { describe, it, expect } from 'vitest';
import { createIngressApp } from '../../src/ingress/app.ts';
import { startWorker } from '../../src/worker/worker.ts';
import { InMemoryQueueAdapter } from '../../src/adapters/queue/in-memory-queue.adapter.ts';
import { WorkflowRouter } from '../../src/orchestrator/workflow-router.ts';
import { strategyOnboardHandler } from '../../src/orchestrator/handlers/strategy-onboard.handler.ts';
import { makeServices } from '../support/make-services.ts';
import { sourceFingerprint } from '../../src/domain/fingerprint.ts';

describe('E2E: strategy.onboard ingress -> worker -> profile', () => {
  it('drives an onboard task from POST to a persisted StrategyProfile', async () => {
    const queue = new InMemoryQueueAdapter();
    const services = makeServices();
    const router = new WorkflowRouter();
    router.register('strategy.onboard', strategyOnboardHandler);
    startWorker({ queue, router, services });

    const app = createIngressApp({ repo: services.researchTasks, queue, taskToken: 'e2e-task-token' });
    const res = await app.request('/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer e2e-task-token' },
      body: JSON.stringify({
        taskType: 'strategy.onboard', source: 'operator',
        payload: { kind: 'manual_description', content: 'long OI divergence', title: 'OI div' },
      }),
    });
    expect(res.status).toBe(202);
    const { taskId } = (await res.json()) as { taskId: string };

    await queue.drain();

    expect((await services.researchTasks.findById(taskId))?.status).toBe('completed');
    const fp = sourceFingerprint('manual_description', 'long OI divergence');
    const profile = await services.strategyProfiles.findByFingerprint(fp);
    expect(profile).not.toBeNull();
    expect(profile?.sourceKind).toBe('manual_description');
    expect(profile?.sourceFingerprint).toBe(fp); // the persisted record really carries this fingerprint
    // Exactly started+completed (no `strategy.onboard.deduped` — this is the fresh happy path)
    const events = (await services.events.listByTask(taskId)).map((e) => e.type);
    expect(events).toEqual(['strategy_analyst.started', 'strategy_analyst.completed']);
  });
});
