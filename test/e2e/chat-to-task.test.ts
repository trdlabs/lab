import { describe, it, expect } from 'vitest';
import { createChatApp } from '../../src/chat/chat-app.ts';
import { advanceChatPlan } from '../../src/orchestrator/chain-runner.ts';
import { makeServices } from '../support/make-services.ts';
import { FakeIntentClassifier } from '../../src/adapters/intent/fake-intent-classifier.ts';
import { InMemoryQueueAdapter } from '../../src/adapters/queue/in-memory-queue.adapter.ts';
import { WorkflowRouter } from '../../src/orchestrator/workflow-router.ts';
import { strategyOnboardHandler } from '../../src/orchestrator/handlers/strategy-onboard.handler.ts';
import { researchRunCycleHandler } from '../../src/orchestrator/handlers/research-run-cycle.handler.ts';

describe('e2e: chat -> onboard task -> auto-chain research', () => {
  it('creates an onboard task from chat text and auto-chains research on completion', async () => {
    const queue = new InMemoryQueueAdapter();
    const services = makeServices();
    const router = new WorkflowRouter();
    router.register('strategy.onboard', strategyOnboardHandler);
    router.register('research.run_cycle', researchRunCycleHandler);

    // Worker loop + the chat completion hook (mirrors src/worker/worker.ts wiring).
    queue.process(async (envelope) => {
      const task = await services.researchTasks.findById(envelope.taskId);
      if (!task) throw new Error(`task not found: ${envelope.taskId}`);
      await services.researchTasks.updateStatus(task.id, 'running');
      await router.dispatch({ ...task, status: 'running' }, services);
      await services.researchTasks.updateStatus(task.id, 'completed');
      await advanceChatPlan({ ...task, status: 'completed' }, {
        researchTasks: services.researchTasks, strategyProfiles: services.strategyProfiles,
        events: services.events, sessions: services.chatSessions, plans: services.chatPlans, queue,
      });
    });

    const app = createChatApp({
      classifier: new FakeIntentClassifier(),
      sessions: services.chatSessions, plans: services.chatPlans,
      researchTasks: services.researchTasks, strategyProfiles: services.strategyProfiles,
      hypotheses: services.hypotheses, events: services.events, queue,
      minConfidence: 0.6, maxMessageChars: 4000,
      authToken: 'e2e-chat-token',
    });

    const res = await app.request('/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer e2e-chat-token' },
      body: JSON.stringify({ message: 'исследуй эту стратегию: лонг при росте OI и падении цены', sessionId: 's1' }),
    });
    const body = await res.json() as { kind: string; taskId: string; plannedNextStep?: { taskType: string } };
    expect(body.kind).toBe('task_created');
    expect(body.plannedNextStep?.taskType).toBe('research.run_cycle');

    // Drain: onboard runs (creates a profile), the hook enqueues research, which also drains.
    await queue.drain();

    const session = await services.chatSessions.get('s1');
    expect(session?.lastStrategyProfileId).toBeTruthy();
    expect(session?.lastResearchTaskId).toBeTruthy();
    const research = await services.researchTasks.findById(session!.lastResearchTaskId!);
    expect(research?.taskType).toBe('research.run_cycle');
    expect(research?.status).toBe('completed');
  });
});
