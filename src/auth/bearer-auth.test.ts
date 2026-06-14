import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { bearerAuth } from './bearer-auth.ts';

function app(token?: string, message = 'service ingress not configured'): Hono {
  const a = new Hono();
  a.use('*', bearerAuth(token, { notConfiguredMessage: message }));
  a.post('/x', (c) => c.json({ ok: true }));
  return a;
}

function post(a: Hono, token?: string | null) {
  const headers: Record<string, string> = {};
  if (token != null) headers.authorization = `Bearer ${token}`;
  return a.request('/x', { method: 'POST', headers });
}

describe('bearerAuth factory', () => {
  it('503 with the supplied notConfiguredMessage when the token is unset', async () => {
    const res = await post(app(undefined, 'task ingress not configured'), 'anything');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'service_unavailable', message: 'task ingress not configured' } });
  });

  it('503 when the token is an empty string', async () => {
    expect((await post(app(''), 'anything')).status).toBe(503);
  });

  it('401 when the token is set but the Authorization header is missing', async () => {
    const res = await post(app('secret'), null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'unauthorized', message: 'missing or invalid token' } });
  });

  it('401 when the token is set but the Bearer value is wrong', async () => {
    expect((await post(app('secret'), 'nope')).status).toBe(401);
  });

  it('passes through to the route when the Bearer value matches', async () => {
    const res = await post(app('secret'), 'secret');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('emits a distinct notConfiguredMessage per boundary', async () => {
    const res = await post(app(undefined, 'callback ingress not configured'), null);
    expect(await res.json()).toEqual({ error: { code: 'service_unavailable', message: 'callback ingress not configured' } });
  });
});
