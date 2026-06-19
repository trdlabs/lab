import { describe, it, expect, vi } from 'vitest';
import { createChatApp } from '../../src/chat/chat-app.ts';
import { makeServices } from '../support/make-services.ts';
import { FakeTurnInterpreter } from '../../src/adapters/intent/fake-turn-interpreter.ts';
import { FakeOperatorRetrieval } from '../support/fake-operator-retrieval.ts';
import { InMemoryQueueAdapter } from '../../src/adapters/queue/in-memory-queue.adapter.ts';
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
/** Distinctive token that must NEVER appear in any serialised event payload (privacy check). */
const STRATEGY_TOKEN = 'лонг при росте OI';

/** Build a fresh chat app + supporting objects for each test case. */
function buildApp(retrieval: FakeOperatorRetrieval, interpreter: FakeTurnInterpreter) {
  const queue = new InMemoryQueueAdapter();
  const services = makeServices();
  const events = new EventSpy(services.events);

  const app = createChatApp({
    interpreter,
    retrieval,
    sessions: services.chatSessions,
    plans: services.chatPlans,
    researchTasks: services.researchTasks,
    strategyProfiles: services.strategyProfiles,
    hypotheses: services.hypotheses,
    events,
    queue,
    proposals: services.actionProposals,
    proposalTtlMs: 600_000,
    minConfidence: 0.6,
    maxMessageChars: 4000,
    authToken: 'rag-e2e-token',
  });

  const headers = { 'content-type': 'application/json', authorization: 'Bearer rag-e2e-token' };

  const post = (message: string, sessionId: string) =>
    app.request('/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({ message, sessionId }),
    });

  return { app, queue, services, events, post };
}

describe('e2e: operator RAG interpret → retrieve → propose → confirm', () => {

  // ── 1. Standalone strategy → proposal ────────────────────────────────────────
  it('turn 1: strategy message returns assistant_message with evidence cards and confirm/cancel; nothing queued', async () => {
    const retrieval = new FakeOperatorRetrieval();
    const interpreter = new FakeTurnInterpreter();
    const interpretSpy = vi.spyOn(interpreter, 'interpret');
    const { post, queue } = buildApp(retrieval, interpreter);

    const res = await post(STRATEGY_MESSAGE, 'rag-s1');
    expect(res.status).toBe(200);

    const body = await res.json() as {
      kind: string;
      evidence: { kind: string }[];
      actions: { id: string }[];
      pendingInteractionId?: string;
    };

    expect(body.kind).toBe('assistant_message');
    expect(body.pendingInteractionId).toBeTruthy();
    expect(body.actions.map((a) => a.id)).toEqual(['confirm', 'cancel']);

    // Evidence must include at least the interpretation card.
    expect(body.evidence.length).toBeGreaterThanOrEqual(1);
    expect(body.evidence.some((c) => c.kind === 'interpretation')).toBe(true);

    // Interpreter was called exactly once.
    expect(interpretSpy).toHaveBeenCalledTimes(1);

    // Nothing enqueued on the first turn.
    expect(queue.queued).toHaveLength(0);
  });

  // ── 2. Exact-hit variant ─────────────────────────────────────────────────────
  it('exact-hit: evidence contains exact_duplicate card; similar candidates use "similar" kind, never "exact_duplicate"', async () => {
    const exactMatch = {
      strategyProfileId: 'sp-existing-001',
      label: 'Long OI Drop v1',
      observedAt: new Date().toISOString(),
    };
    const similar = {
      strategyProfileId: 'sp-similar-002',
      lexicalRank: 1,
      lexicalScore: 0.8,
      rrfScore: 0.7,
      metadata: {},
    };
    const retrieval = new FakeOperatorRetrieval({
      exactLookup: 'hit',
      exactMatch,
      similarStrategies: [similar],
    });
    const interpreter = new FakeTurnInterpreter();
    const { post } = buildApp(retrieval, interpreter);

    const res = await post(STRATEGY_MESSAGE, 'rag-s2');
    expect(res.status).toBe(200);

    const body = await res.json() as { kind: string; evidence: { kind: string; sourceId?: string }[] };
    expect(body.kind).toBe('assistant_message');

    const exactCards = body.evidence.filter((c) => c.kind === 'exact_duplicate');
    const similarCards = body.evidence.filter((c) => c.kind === 'similar');

    // Exactly one exact_duplicate card, pointing at the matched profile.
    expect(exactCards).toHaveLength(1);
    expect(exactCards[0]?.sourceId).toBe('sp-existing-001');

    // The similar candidate is labelled "similar", never "exact_duplicate".
    expect(similarCards).toHaveLength(1);
    expect(similarCards[0]?.sourceId).toBe('sp-similar-002');
    expect(similarCards.every((c) => c.kind === 'similar')).toBe(true);
  });

  // ── 3. Degraded variant ──────────────────────────────────────────────────────
  it('degraded: warning card is present AND structured/lexical similar evidence is still shown', async () => {
    const similar = {
      strategyProfileId: 'sp-lexical-003',
      lexicalRank: 1,
      lexicalScore: 0.75,
      rrfScore: 0.65,
      metadata: {},
    };
    const retrieval = new FakeOperatorRetrieval({
      status: 'degraded',
      exactLookup: 'miss',
      warningCodes: ['vector_failed'],
      similarStrategies: [similar],
    });
    const interpreter = new FakeTurnInterpreter();
    const { post } = buildApp(retrieval, interpreter);

    const res = await post(STRATEGY_MESSAGE, 'rag-s3');
    expect(res.status).toBe(200);

    const body = await res.json() as { kind: string; evidence: { kind: string; text?: string; sourceId?: string }[] };
    expect(body.kind).toBe('assistant_message');

    // Warning card present.
    const warningCards = body.evidence.filter((c) => c.kind === 'warning');
    expect(warningCards.length).toBeGreaterThanOrEqual(1);
    expect(warningCards.some((c) => c.text === 'vector_failed')).toBe(true);

    // Similar evidence still present despite degraded status (no false "nothing found").
    const similarCards = body.evidence.filter((c) => c.kind === 'similar');
    expect(similarCards).toHaveLength(1);
    expect(similarCards[0]?.sourceId).toBe('sp-lexical-003');
  });

  // ── 4. Confirm bypasses interpreter + retrieval ──────────────────────────────
  it('confirm turn: does NOT call interpreter.interpret or retrieval.collect; returns task_created', async () => {
    const retrieval = new FakeOperatorRetrieval();
    const interpreter = new FakeTurnInterpreter();
    const interpretSpy = vi.spyOn(interpreter, 'interpret');
    const collectSpy = vi.spyOn(retrieval, 'collect');
    const { post, queue } = buildApp(retrieval, interpreter);
    const SESSION = 'rag-s4';

    // Turn 1: propose.
    const turn1 = await post(STRATEGY_MESSAGE, SESSION);
    expect(turn1.status).toBe(200);
    const proposed = await turn1.json() as { kind: string };
    expect(proposed.kind).toBe('assistant_message');

    const callsAfterTurn1 = { interpret: interpretSpy.mock.calls.length, collect: collectSpy.mock.calls.length };
    expect(callsAfterTurn1.interpret).toBe(1);
    expect(callsAfterTurn1.collect).toBe(1);

    // Turn 2: confirm.
    const turn2 = await post('да', SESSION);
    expect(turn2.status).toBe(200);
    const confirmed = await turn2.json() as { kind: string; taskId: string };
    expect(confirmed.kind).toBe('task_created');
    expect(confirmed.taskId).toBeTruthy();

    // Spy counts unchanged after confirmation turn — neither port was called again.
    expect(interpretSpy).toHaveBeenCalledTimes(callsAfterTurn1.interpret);
    expect(collectSpy).toHaveBeenCalledTimes(callsAfterTurn1.collect);

    // Task was enqueued.
    expect(queue.queued).toHaveLength(1);
  });

  // ── 5. Event order (turn 1) ───────────────────────────────────────────────────
  it('event order (turn 1): chat.turn.interpreted → chat.retrieval.completed → chat.proposal.created', async () => {
    const retrieval = new FakeOperatorRetrieval();
    const interpreter = new FakeTurnInterpreter();
    const { post, events } = buildApp(retrieval, interpreter);

    const res = await post(STRATEGY_MESSAGE, 'rag-s5');
    expect(res.status).toBe(200);
    const body = await res.json() as { kind: string };
    expect(body.kind).toBe('assistant_message');

    const types = events.all.map((e) => e.type);

    const idxInterpreted = types.indexOf('chat.turn.interpreted');
    const idxRetrieval = types.indexOf('chat.retrieval.completed');
    const idxProposal = types.indexOf('chat.proposal.created');

    expect(idxInterpreted).toBeGreaterThanOrEqual(0);
    expect(idxRetrieval).toBeGreaterThanOrEqual(0);
    expect(idxProposal).toBeGreaterThanOrEqual(0);

    expect(idxRetrieval).toBeGreaterThan(idxInterpreted);
    expect(idxProposal).toBeGreaterThan(idxRetrieval);
  });

  // ── 6. Privacy ────────────────────────────────────────────────────────────────
  it('privacy: no raw strategy text and no embedding numbers in any event payload', async () => {
    const retrieval = new FakeOperatorRetrieval({
      similarStrategies: [
        {
          strategyProfileId: 'sp-priv-001',
          lexicalRank: 1,
          lexicalScore: 0.9,
          rrfScore: 0.85,
          // embedding numbers must not reach the event bus
          metadata: {},
        },
      ],
    });
    const interpreter = new FakeTurnInterpreter();
    const { post, events } = buildApp(retrieval, interpreter);

    const res = await post(STRATEGY_MESSAGE, 'rag-s6');
    expect(res.status).toBe(200);

    const serialised = JSON.stringify(events.all);

    // Raw strategy text must never appear in events.
    expect(serialised).not.toContain(STRATEGY_TOKEN);

    // No array of floating-point numbers (embeddings would look like [0.123, 0.456, ...]).
    // Match an array that starts with a decimal number literal.
    expect(serialised).not.toMatch(/\[\s*-?\d+\.\d{3,}/);
  });
});
