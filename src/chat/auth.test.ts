import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { chatAuthMiddleware } from './auth.ts';
import { readAuthMiddleware } from '../read-api/auth.ts'; // test-only: cross-boundary separation proof

function chatApp(token?: string): Hono {
  const app = new Hono();
  app.use('*', chatAuthMiddleware(token));
  app.post('/messages', (c) => c.json({ ok: true }));
  return app;
}

function readApp(token: string): Hono {
  const app = new Hono();
  app.use('*', readAuthMiddleware(token));
  app.get('/x', (c) => c.json({ ok: true }));
  return app;
}

function post(app: Hono, token?: string | null) {
  const headers: Record<string, string> = {};
  if (token != null) headers.authorization = `Bearer ${token}`;
  return app.request('/messages', { method: 'POST', headers });
}

describe('chatAuthMiddleware', () => {
  it('503 service_unavailable when the token is unset', async () => {
    const res = await post(chatApp(undefined), 'anything');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'service_unavailable', message: 'chat ingress not configured' } });
  });

  it('503 when the token is empty string', async () => {
    expect((await post(chatApp(''), 'anything')).status).toBe(503);
  });

  it('401 when the token is set but the Authorization header is missing', async () => {
    const res = await post(chatApp('chat-secret'), null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'unauthorized', message: 'missing or invalid token' } });
  });

  it('401 when the token is set but the Bearer value is wrong', async () => {
    expect((await post(chatApp('chat-secret'), 'nope')).status).toBe(401);
  });

  it('passes through to the route when the Bearer value matches', async () => {
    const res = await post(chatApp('chat-secret'), 'chat-secret');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('chat/read boundary separation', () => {
  it('chat ingress rejects a read token', async () => {
    expect((await post(chatApp('chat-token'), 'read-token')).status).toBe(401);
  });

  it('read API rejects a chat token', async () => {
    const res = await readApp('read-token').request('/x', { headers: { authorization: 'Bearer chat-token' } });
    expect(res.status).toBe(401);
  });
});
