import { describe, it, expect } from 'vitest';
import { createChatApp, type ChatAppDeps } from './chat-app.ts';
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
