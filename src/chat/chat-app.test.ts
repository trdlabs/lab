import { describe, it, expect } from 'vitest';
import { createChatApp, type ChatAppDeps } from './chat-app.ts';
import { ChatRateLimiter } from './chat-rate-limiter.ts';
import type { TurnInterpreterPort } from '../ports/turn-interpreter.port.ts';
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

const CHAT_TOKEN = 'chat-test-token';

function appDeps(over: Partial<ChatAppDeps> = {}): ChatAppDeps {
  return {
    interpreter: new FakeTurnInterpreter(),
    retrieval: new FakeOperatorRetrieval(),
    sessions: new InMemoryChatSessionRepository(),
    plans: new InMemoryChatPlanRepository(),
    researchTasks: new InMemoryResearchTaskRepository(),
    strategyProfiles: new InMemoryStrategyProfileRepository(),
    hypotheses: new InMemoryHypothesisProposalRepository(),
    events: new InMemoryAgentEventRepository(),
    queue: new InMemoryQueueAdapter(),
    proposals: new InMemoryActionProposalRepository(),
    strategyCritic: null,
    proposalTtlMs: 600_000,
    minConfidence: 0.6,
    defaultPlatformRun: { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2023-01-01', to: '2023-06-30' }, seed: 7 },
    maxMessageChars: 4000,
    authToken: CHAT_TOKEN,
    ...over,
  };
}

function post(
  app: ReturnType<typeof createChatApp>,
  body: unknown,
  opts: { token?: string | null; rawBody?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = opts.token === undefined ? CHAT_TOKEN : opts.token; // default: valid; null omits header
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return app.request('/messages', {
    method: 'POST',
    headers,
    body: opts.rawBody !== undefined ? opts.rawBody : JSON.stringify(body),
  });
}

describe('POST /chat/messages', () => {
  it('rejects an empty message with 400', async () => {
    const app = createChatApp(appDeps());
    const res = await post(app, { message: '' });
    expect(res.status).toBe(400);
  });

  it('rejects a whitespace-only message with 400 and never calls the interpreter', async () => {
    let calls = 0;
    const spy = {
      adapter: 'fake' as const,
      model: 'fake',
      interpret: async () => { calls += 1; return { subject: 'unknown', constraints: {}, references: [], confidence: 1 }; },
    };
    const app = createChatApp(appDeps({ interpreter: spy }));
    const res = await post(app, { message: '   ' });
    expect(res.status).toBe(400);
    expect(calls).toBe(0); // schema gate rejects before handler/interpreter runs
  });

  it('rejects an oversize message with 400', async () => {
    const app = createChatApp(appDeps({ maxMessageChars: 5 }));
    const res = await post(app, { message: 'this is way too long' });
    expect(res.status).toBe(400);
    const body = await res.json() as { reason?: string };
    expect(body.reason).toBe('message_too_long');
  });

  it('returns 200 + out_of_scope for a weather question and generates a sessionId', async () => {
    const app = createChatApp(appDeps());
    const res = await post(app, { message: 'какая сегодня погода?' });
    expect(res.status).toBe(200);
    const body = await res.json() as { kind: string; sessionId: string };
    expect(body.kind).toBe('out_of_scope');
    expect(body.sessionId.length).toBeGreaterThan(0);
  });

  it('returns 200 + assistant_message proposal and echoes the provided sessionId', async () => {
    const app = createChatApp(appDeps());
    const res = await post(app, { message: 'исследуй эту стратегию: лонг при росте OI', sessionId: 'sess-42' });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      kind: string; sessionId: string; pendingInteractionId?: string; actions?: { id: string }[];
    };
    expect(body.kind).toBe('assistant_message');
    expect(body.sessionId).toBe('sess-42');
    expect(body.pendingInteractionId).toBeTruthy();
    expect(body.actions?.map((a) => a.id)).toEqual(['confirm', 'cancel']);
  });
});

describe('POST /chat/confirm', () => {
  it('confirms a pending proposal -> task_created', async () => {
    const deps = appDeps();
    const app = createChatApp(deps);

    // Arrange: drive one /messages turn that leaves a pending proposal.
    const firstRes = await app.request('/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${CHAT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'исследуй эту стратегию: лонг при росте OI', sessionId: 'sess-confirm-1' }),
    });
    const proposal = await firstRes.json() as { kind: string; sessionId: string; pendingInteractionId?: string };
    expect(proposal.kind).toBe('assistant_message');
    expect(proposal.pendingInteractionId).toBeTruthy();

    // Act: structured confirm.
    const res = await app.request('/confirm', {
      method: 'POST',
      headers: { Authorization: `Bearer ${CHAT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pendingInteractionId: proposal.pendingInteractionId,
        sessionId: proposal.sessionId,
        decision: 'confirm',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { kind: string; taskId?: string };
    expect(body.kind).toBe('task_created');
    expect(body.taskId).toBeTruthy();
  });

  it('with unset token -> 503', async () => {
    const noAuth = createChatApp(appDeps({ authToken: undefined }));
    const res = await noAuth.request('/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingInteractionId: 'p', sessionId: 's', decision: 'confirm' }),
    });
    expect(res.status).toBe(503);
  });

  it('for an unknown proposal -> graceful assistant_message (not 500)', async () => {
    const app = createChatApp(appDeps());
    const res = await app.request('/confirm', {
      method: 'POST',
      headers: { Authorization: `Bearer ${CHAT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingInteractionId: 'nope', sessionId: 'ghost', decision: 'confirm' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { kind: string };
    expect(body.kind).toBe('assistant_message');
  });

  it('with a bad decision -> 400 rejected', async () => {
    const app = createChatApp(appDeps());
    const res = await app.request('/confirm', {
      method: 'POST',
      headers: { Authorization: `Bearer ${CHAT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingInteractionId: 'p', sessionId: 's', decision: 'maybe' }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts decision=accept_as_is -> task_created', async () => {
    const deps = appDeps();
    const app = createChatApp(deps);
    const firstRes = await app.request('/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${CHAT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'исследуй эту стратегию: лонг при росте OI', sessionId: 'sess-accept-1' }),
    });
    const proposal = await firstRes.json() as { sessionId: string; pendingInteractionId?: string };
    const res = await app.request('/confirm', {
      method: 'POST',
      headers: { Authorization: `Bearer ${CHAT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pendingInteractionId: proposal.pendingInteractionId,
        sessionId: proposal.sessionId,
        decision: 'accept_as_is',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { kind: string };
    expect(body.kind).toBe('task_created');
  });
});

describe('chat auth gate runs before body parsing', () => {
  it('401 (not 400) for a malformed JSON body when the token is set but auth is missing', async () => {
    const app = createChatApp(appDeps());
    const res = await post(app, undefined, { token: null, rawBody: '{ this is not json' });
    expect(res.status).toBe(401); // auth gate rejects before c.req.json() runs — never a 400 validation error
  });

  it('503 (not 400) for a malformed JSON body when the token is unset', async () => {
    const app = createChatApp(appDeps({ authToken: undefined }));
    const res = await post(app, undefined, { token: null, rawBody: '{ this is not json' });
    expect(res.status).toBe(503);
  });

  it('401 for a well-formed request when the Bearer token is wrong', async () => {
    const app = createChatApp(appDeps());
    const res = await post(app, { message: 'привет' }, { token: 'wrong-token' });
    expect(res.status).toBe(401);
  });
});

describe('POST /chat/messages rate limiting (P1-22)', () => {
  it('serves turns up to the window cap, then rejects with 429 rate_limited', async () => {
    const app = createChatApp(appDeps({ rateLimiter: new ChatRateLimiter({ maxTurns: 1, windowMs: 60_000 }) }));
    const first = await post(app, { message: 'какая сегодня погода?' });
    expect(first.status).toBe(200);
    const second = await post(app, { message: 'какая сегодня погода?' });
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ status: 'rejected', reason: 'rate_limited' });
  });

  it('rejects a second in-flight turn on the same session with 429 concurrent_request', async () => {
    // Park the first turn inside interpret() so it holds the per-session lock when the second arrives.
    let openGate!: () => void;
    const gate = new Promise<void>((r) => { openGate = r; });
    let signalEntered!: () => void;
    const entered = new Promise<void>((r) => { signalEntered = r; });
    const fake = new FakeTurnInterpreter();
    const gated: TurnInterpreterPort = {
      adapter: 'fake', model: 'gated',
      interpret: async (m: string) => { signalEntered(); await gate; return fake.interpret(m); },
    };
    const app = createChatApp(appDeps({
      interpreter: gated,
      rateLimiter: new ChatRateLimiter({ maxTurns: 100, windowMs: 60_000 }),
    }));

    const p1 = post(app, { message: 'какая сегодня погода?', sessionId: 'sess-conc' });
    await entered; // first turn now parked in interpret() → lock held
    const second = await post(app, { message: 'какая сегодня погода?', sessionId: 'sess-conc' });
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ status: 'rejected', reason: 'concurrent_request' });

    openGate();
    expect((await p1).status).toBe(200); // first completes and releases the lock
    // lock released → same session can run again
    const third = await post(app, { message: 'какая сегодня погода?', sessionId: 'sess-conc' });
    expect(third.status).toBe(200);
  });

  it('no limiter configured → never rate-limited (back-compat)', async () => {
    const app = createChatApp(appDeps());
    for (let i = 0; i < 5; i++) {
      expect((await post(app, { message: 'какая сегодня погода?' })).status).toBe(200);
    }
  });
});
