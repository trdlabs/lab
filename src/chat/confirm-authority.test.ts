import { describe, it, expect } from 'vitest';
import { consumeConfirmation, type ChatHandlerDeps } from './chat-handler.ts';
import { assertConfirmableProposal, ExecutionAuthorityError } from './confirm-authority.ts';
import { FakeTurnInterpreter } from '../adapters/intent/fake-turn-interpreter.ts';
import { FakeOperatorRetrieval } from '../../test/support/fake-operator-retrieval.ts';
import { InMemoryResearchTaskRepository } from '../adapters/repository/in-memory-research-task.repository.ts';
import { InMemoryStrategyProfileRepository } from '../adapters/repository/in-memory-strategy-profile.repository.ts';
import { InMemoryHypothesisProposalRepository } from '../adapters/repository/in-memory-hypothesis-proposal.repository.ts';
import { InMemoryAgentEventRepository } from '../adapters/repository/in-memory-agent-event.repository.ts';
import { InMemoryChatSessionRepository } from '../adapters/repository/in-memory-chat-session.repository.ts';
import { InMemoryChatPlanRepository } from '../adapters/repository/in-memory-chat-plan.repository.ts';
import { InMemoryActionProposalRepository } from '../adapters/repository/in-memory-action-proposal.repository.ts';
import { InMemoryQueueAdapter } from '../adapters/queue/in-memory-queue.adapter.ts';
import type { ActionProposal, OperatorAction } from '../domain/action-proposal.ts';
import type { AgentTaskType } from '../domain/types.ts';
import type { ChatSessionContext } from '../ports/chat-session.repository.ts';

const NOW = '2026-07-21T00:00:00.000Z';
const now = (): string => NOW;
const noop = async (): Promise<void> => {};

function ctx() {
  const researchTasks = new InMemoryResearchTaskRepository();
  const queue = new InMemoryQueueAdapter();
  const events = new InMemoryAgentEventRepository();
  const proposals = new InMemoryActionProposalRepository();
  const sessions = new InMemoryChatSessionRepository();
  const d: ChatHandlerDeps = {
    interpreter: new FakeTurnInterpreter(),
    retrieval: new FakeOperatorRetrieval(),
    sessions,
    plans: new InMemoryChatPlanRepository(),
    researchTasks,
    strategyProfiles: new InMemoryStrategyProfileRepository(),
    hypotheses: new InMemoryHypothesisProposalRepository(),
    events,
    queue,
    proposals,
    strategyCritic: null,
    proposalTtlMs: 600_000,
    minConfidence: 0.6,
    defaultPlatformRun: { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2023-01-01', to: '2023-06-30' }, seed: 7 },
  };
  return { d, queue, researchTasks, proposals, events };
}

const session = (): ChatSessionContext => ({ sessionId: 's1', updatedAt: NOW });

/**
 * A proposal is rehydrated from a JSONB column, so its `action` / `taskType` are untrusted
 * strings at runtime whatever the compile-time types say. The casts below model exactly that:
 * a row the planner would never write today, but that the confirm path must still refuse.
 */
function proposal(over: { action?: string; taskType?: string; chain?: { nextTaskType: string } } = {}): ActionProposal {
  return {
    id: 'p1',
    sessionId: 's1',
    subjectHash: 'h1',
    action: (over.action ?? 'strategy.analyze') as OperatorAction,
    source: 'web',
    task: {
      taskType: (over.taskType ?? 'strategy.onboard') as AgentTaskType,
      payload: { content: 'лонг по тренду', sourceType: 'manual_description' },
      dedupeKey: 'chat-proposal:p1',
      userGoal: 'strategy.analyze',
      ...(over.chain ? { chain: { nextTaskType: over.chain.nextTaskType as 'research.run_cycle', resolveProfileByFingerprint: 'h1' } } : {}),
    },
    status: 'pending',
    evidenceRefs: [],
    evidenceWarnings: [],
    expiresAt: '2026-07-21T01:00:00.000Z',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('assertConfirmableProposal', () => {
  it('admits the research actions the chat planner produces today', () => {
    expect(() => assertConfirmableProposal(proposal({ action: 'strategy.analyze', taskType: 'strategy.onboard' }))).not.toThrow();
    expect(() => assertConfirmableProposal(proposal({ action: 'hypothesis.build', taskType: 'hypothesis.build' }))).not.toThrow();
    expect(() => assertConfirmableProposal(proposal({ action: 'research.run_cycle', taskType: 'strategy.onboard' }))).not.toThrow();
  });

  it('admits the research follow-ups a confirmed proposal may chain into', () => {
    expect(() => assertConfirmableProposal(proposal({ chain: { nextTaskType: 'research.run_cycle' } }))).not.toThrow();
    expect(() => assertConfirmableProposal(proposal({ chain: { nextTaskType: 'strategy.baseline' } }))).not.toThrow();
  });

  // The allowlist earns its keep here: paper.start already exists in AGENT_TASK_TYPES, so a
  // planner change alone must not make it confirmable from a chat turn.
  it('refuses an execution-capable task type', () => {
    expect(() => assertConfirmableProposal(proposal({ taskType: 'paper.start' }))).toThrow(ExecutionAuthorityError);
    expect(() => assertConfirmableProposal(proposal({ taskType: 'paper.monitor' }))).toThrow(ExecutionAuthorityError);
  });

  it('refuses an execution-capable chained task type', () => {
    expect(() => assertConfirmableProposal(proposal({ chain: { nextTaskType: 'paper.start' } }))).toThrow(ExecutionAuthorityError);
  });

  it('refuses an unknown action and an unknown task type by default', () => {
    expect(() => assertConfirmableProposal(proposal({ action: 'order.place' }))).toThrow(ExecutionAuthorityError);
    expect(() => assertConfirmableProposal(proposal({ taskType: 'trade.execute' }))).toThrow(ExecutionAuthorityError);
  });

  it('carries a stable reason code and never echoes the payload', () => {
    try {
      assertConfirmableProposal(proposal({ taskType: 'paper.start' }));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ExecutionAuthorityError);
      expect((err as ExecutionAuthorityError).reason).toBe('execution_authority_denied');
      expect((err as Error).message).not.toContain('лонг по тренду');
    }
  });
});

describe('consumeConfirmation — authority boundary', () => {
  it('confirms a safe research proposal: task enqueued', async () => {
    const c = ctx();
    await c.proposals.create(proposal());
    const r = await consumeConfirmation({ proposalId: 'p1', decision: 'confirm', session: session() }, c.d, noop, now);
    expect(r.kind).toBe('task_created');
    expect(c.queue.queued).toHaveLength(1);
  });

  it('cancel is always allowed and executes nothing', async () => {
    const c = ctx();
    await c.proposals.create(proposal({ taskType: 'paper.start' }));
    const r = await consumeConfirmation({ proposalId: 'p1', decision: 'cancel', session: session() }, c.d, noop, now);
    expect(r.kind).toBe('assistant_message');
    expect(c.queue.queued).toHaveLength(0);
    expect((await c.proposals.findById('p1'))?.status).toBe('cancelled');
  });

  it('refuses an execution-capable confirm before any side effect', async () => {
    const c = ctx();
    await c.proposals.create(proposal({ taskType: 'paper.start' }));

    await expect(
      consumeConfirmation({ proposalId: 'p1', decision: 'confirm', session: session() }, c.d, noop, now),
    ).rejects.toBeInstanceOf(ExecutionAuthorityError);

    // executeConfirmedProposal never ran: nothing enqueued, no task created...
    expect(c.queue.queued).toHaveLength(0);
    // ...and the proposal was not burned — the refusal happens before confirmPending, so the
    // row is still pending rather than stuck in 'confirmed' with no task behind it.
    const after = await c.proposals.findById('p1');
    expect(after?.status).toBe('pending');
    expect(after?.confirmedTaskId).toBeUndefined();
  });

  it('refuses accept_as_is on an execution-capable proposal too (both confirm verbs)', async () => {
    const c = ctx();
    await c.proposals.create(proposal({ action: 'order.place' }));
    await expect(
      consumeConfirmation({ proposalId: 'p1', decision: 'accept_as_is', session: session() }, c.d, noop, now),
    ).rejects.toBeInstanceOf(ExecutionAuthorityError);
    expect(c.queue.queued).toHaveLength(0);
    expect((await c.proposals.findById('p1'))?.status).toBe('pending');
  });

  it('records an audit event for the refusal', async () => {
    const c = ctx();
    await c.proposals.create(proposal({ taskType: 'paper.start' }));
    const seen: string[] = [];
    const ev = async (type: string): Promise<void> => { seen.push(type); };
    await expect(
      consumeConfirmation({ proposalId: 'p1', decision: 'confirm', session: session() }, c.d, ev, now),
    ).rejects.toBeInstanceOf(ExecutionAuthorityError);
    expect(seen).toContain('chat.proposal.authority_denied');
  });

  it('a proposal belonging to another session is not judged here — it stays not_found', async () => {
    const c = ctx();
    await c.proposals.create({ ...proposal({ taskType: 'paper.start' }), sessionId: 'someone-else' });
    const r = await consumeConfirmation({ proposalId: 'p1', decision: 'confirm', session: session() }, c.d, noop, now);
    expect(r.kind).toBe('assistant_message');
    expect(c.queue.queued).toHaveLength(0);
    expect((await c.proposals.findById('p1'))?.status).toBe('pending');
  });
});
