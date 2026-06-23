import { describe, it, expect } from 'vitest';
import { createChatApp } from '../../src/chat/chat-app.ts';
import { advanceChatPlan } from '../../src/orchestrator/chain-runner.ts';
import { makeServices } from '../support/make-services.ts';
import { FakeTurnInterpreter } from '../../src/adapters/intent/fake-turn-interpreter.ts';
import { FakeOperatorRetrieval } from '../support/fake-operator-retrieval.ts';
import { InMemoryQueueAdapter } from '../../src/adapters/queue/in-memory-queue.adapter.ts';
import { WorkflowRouter } from '../../src/orchestrator/workflow-router.ts';
import { strategyOnboardHandler } from '../../src/orchestrator/handlers/strategy-onboard.handler.ts';
import { researchRunCycleHandler } from '../../src/orchestrator/handlers/research-run-cycle.handler.ts';
import type { AgentEvent, AgentEventRepository } from '../../src/ports/agent-event.repository.ts';

/** Thin event spy: wraps any AgentEventRepository and records every append in order. */
class EventSpy implements AgentEventRepository {
  readonly all: AgentEvent[] = [];
  constructor(private readonly inner: AgentEventRepository) {}
  async append(event: AgentEvent): Promise<void> {
    this.all.push({ ...event });
    return this.inner.append(event);
  }
  async listByTask(taskId: string): Promise<AgentEvent[]> {
    return this.inner.listByTask(taskId);
  }
}

const STRATEGY_MESSAGE = 'исследуй эту стратегию: лонг при росте OI и падении цены';
/** A distinctive token that must NEVER appear in event payloads (strategy text is private). */
const STRATEGY_TOKEN = 'лонг при росте OI';

describe('e2e: two-turn chat — propose then confirm, then worker drains', () => {
  it('turn 1 returns assistant_message (no task/queue); turn 2 (да) creates task_created; worker auto-chains research', async () => {
    const queue = new InMemoryQueueAdapter();
    const services = makeServices();
    const events = new EventSpy(services.events);

    const router = new WorkflowRouter();
    router.register('strategy.onboard', strategyOnboardHandler);
    router.register('research.run_cycle', researchRunCycleHandler);

    // Worker loop — mirrors src/worker/worker.ts wiring, including the advanceChatPlan hook.
    queue.process(async (envelope) => {
      const task = await services.researchTasks.findById(envelope.taskId);
      if (!task) throw new Error(`task not found: ${envelope.taskId}`);
      await services.researchTasks.updateStatus(task.id, 'running');
      await router.dispatch({ ...task, status: 'running' }, services);
      await services.researchTasks.updateStatus(task.id, 'completed');
      await advanceChatPlan({ ...task, status: 'completed' }, {
        researchTasks: services.researchTasks,
        strategyProfiles: services.strategyProfiles,
        events,
        sessions: services.chatSessions,
        plans: services.chatPlans,
        queue,
      });
    });

    const app = createChatApp({
      interpreter: new FakeTurnInterpreter(),
      retrieval: new FakeOperatorRetrieval(),
      sessions: services.chatSessions, plans: services.chatPlans,
      researchTasks: services.researchTasks, strategyProfiles: services.strategyProfiles,
      hypotheses: services.hypotheses, events, queue,
      proposals: services.actionProposals, proposalTtlMs: 600_000,
      minConfidence: 0.6, maxMessageChars: 4000,
      defaultPlatformRun: { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2023-01-01', to: '2023-06-30' }, seed: 7 },
      authToken: 'e2e-chat-token',
    });

    const headers = { 'content-type': 'application/json', authorization: 'Bearer e2e-chat-token' };

    // ── Turn 1: strategy message ────────────────────────────────────────────
    const firstRes = await app.request('/messages', {
      method: 'POST', headers,
      body: JSON.stringify({ message: STRATEGY_MESSAGE, sessionId: 's1' }),
    });
    expect(firstRes.status).toBe(200);

    const proposed = await firstRes.json() as {
      kind: string;
      sessionId: string;
      pendingInteractionId?: string;
      actions?: { id: string }[];
    };
    expect(proposed.kind).toBe('assistant_message');
    expect(proposed.pendingInteractionId).toBeTruthy();
    expect(proposed.actions?.map((a) => a.id)).toEqual(['confirm', 'cancel']);

    // Nothing was enqueued on the first turn.
    expect(queue.queued).toHaveLength(0);

    // Verify session state after turn 1.
    const sessionAfterTurn1 = await services.chatSessions.get('s1');
    expect(sessionAfterTurn1?.pendingInteraction?.kind).toBe('action_confirmation');
    expect(sessionAfterTurn1?.pendingPlanId).toBeUndefined();
    expect(sessionAfterTurn1?.lastResearchTaskId).toBeUndefined();

    // Proposal snapshot: onboard task + research chain, status pending.
    const proposal = await services.actionProposals.findById(
      sessionAfterTurn1!.pendingInteraction!.proposalId,
    );
    expect(proposal?.status).toBe('pending');
    expect(proposal?.task.taskType).toBe('strategy.onboard');
    expect(proposal?.task.chain?.nextTaskType).toBe('research.run_cycle');

    // No task was created under the proposal's dedupeKey yet.
    expect(
      await services.researchTasks.findByDedupeKey(`chat-proposal:${proposal!.id}`),
    ).toBeNull();

    // ── Event ordering check BEFORE confirmation ────────────────────────────
    // Only chat.proposal.created should exist; no task_created, nothing enqueued.
    const eventTypesBeforeConfirm = events.all.map((e) => e.type);
    expect(eventTypesBeforeConfirm).toContain('chat.proposal.created');
    expect(eventTypesBeforeConfirm).not.toContain('chat.task_created');
    expect(queue.queued).toHaveLength(0);

    // ── Turn 2: operator confirms with 'да' ─────────────────────────────────
    const secondRes = await app.request('/messages', {
      method: 'POST', headers,
      body: JSON.stringify({ message: 'да', sessionId: 's1' }),
    });
    expect(secondRes.status).toBe(200);

    const confirmed = await secondRes.json() as {
      kind: string;
      sessionId: string;
      taskId: string;
      plannedNextStep?: { taskType: string };
    };
    expect(confirmed.kind).toBe('task_created');
    expect(confirmed.taskId).toBeTruthy();
    expect(confirmed.plannedNextStep?.taskType).toBe('research.run_cycle');

    // One task was enqueued immediately after confirmation.
    expect(queue.queued).toHaveLength(1);

    // ── Event ordering after confirmation ───────────────────────────────────
    const eventTypesAfterConfirm = events.all.map((e) => e.type);
    const proposalCreatedIdx = eventTypesAfterConfirm.indexOf('chat.proposal.created');
    const proposalConfirmedIdx = eventTypesAfterConfirm.indexOf('chat.proposal.confirmed');
    const taskCreatedIdx = eventTypesAfterConfirm.indexOf('chat.task_created');
    expect(proposalCreatedIdx).toBeGreaterThanOrEqual(0);
    expect(proposalConfirmedIdx).toBeGreaterThan(proposalCreatedIdx);
    expect(taskCreatedIdx).toBeGreaterThan(proposalConfirmedIdx);

    // ── Privacy assertion ───────────────────────────────────────────────────
    // Raw strategy text must NEVER appear in the serialized event stream.
    expect(JSON.stringify(events.all)).not.toContain(STRATEGY_TOKEN);

    // ── Drain queue: onboard -> auto-chain research ─────────────────────────
    await queue.drain();

    // After drain the session should reference the strategy profile and research task.
    const sessionAfterDrain = await services.chatSessions.get('s1');
    expect(sessionAfterDrain?.lastStrategyProfileId).toBeTruthy();
    expect(sessionAfterDrain?.lastResearchTaskId).toBeTruthy();

    // The research task (auto-chained) should be completed.
    const researchTask = await services.researchTasks.findById(
      sessionAfterDrain!.lastResearchTaskId!,
    );
    expect(researchTask?.taskType).toBe('research.run_cycle');
    expect(researchTask?.status).toBe('completed');
  });
});
