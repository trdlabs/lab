import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { ChatMessageRequestSchema, ChatConfirmRequestSchema } from './request.ts';
import { validateWithSchema } from '../validation/validator.ts';
import type { TaskSource } from '../domain/types.ts';
import type { ChatSessionContext } from '../ports/chat-session.repository.ts';
import { handleChatMessage, consumeConfirmation, type ChatHandlerDeps, type ChatEvFn } from './chat-handler.ts';
import { chatAuthMiddleware } from './auth.ts';

export interface ChatAppDeps extends ChatHandlerDeps {
  maxMessageChars: number;
  authToken?: string;
}

function channelToSource(channel: 'web' | 'telegram'): TaskSource {
  return channel === 'telegram' ? 'telegram' : 'web';
}

export function createChatApp(deps: ChatAppDeps): Hono {
  const app = new Hono();

  // Service-to-service auth gate — first middleware, so unauthorized requests never reach
  // JSON parsing / schema validation / the size cap / the handler.
  app.use('*', chatAuthMiddleware(deps.authToken));

  app.post('/messages', async (c) => {
    const raw = await c.req.json().catch(() => null);
    const validation = validateWithSchema(ChatMessageRequestSchema, raw);
    if (validation.status === 'invalid') {
      return c.json({ status: 'rejected', issues: validation.issues }, 400);
    }
    const req = validation.data;

    // Prefilter: size cap (empty already rejected by the schema's min(1)).
    if (req.message.length > deps.maxMessageChars) {
      return c.json({ status: 'rejected', reason: 'message_too_long', maxMessageChars: deps.maxMessageChars }, 400);
    }

    const sessionId = req.sessionId ?? randomUUID();
    const existing = await deps.sessions.get(sessionId);
    const session: ChatSessionContext = existing ?? { sessionId, updatedAt: new Date().toISOString() };

    const response = await handleChatMessage(
      { message: req.message, session, source: channelToSource(req.channel) },
      deps,
    );
    return c.json(response, 200);
  });

  app.post('/confirm', async (c) => {
    const raw = await c.req.json().catch(() => null);
    const validation = validateWithSchema(ChatConfirmRequestSchema, raw);
    if (validation.status === 'invalid') {
      return c.json({ status: 'rejected', issues: validation.issues }, 400);
    }
    const req = validation.data;

    const now = (): string => new Date().toISOString();
    const chatRequestId = randomUUID();
    const ev: ChatEvFn = (type, payload) =>
      deps.events.append({ id: randomUUID(), taskId: chatRequestId, type, payload, createdAt: now() });

    const existing = await deps.sessions.get(req.sessionId);
    const session: ChatSessionContext = existing ?? { sessionId: req.sessionId, updatedAt: now() };

    const response = await consumeConfirmation(
      { proposalId: req.pendingInteractionId, decision: req.decision, session },
      deps,
      ev,
      now,
    );
    return c.json(response, 200);
  });

  return app;
}
