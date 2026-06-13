import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { readAuthMiddleware, safeEqual } from './auth.ts';

function appWithToken(token: string): Hono {
  const app = new Hono();
  app.use('*', readAuthMiddleware(token));
  app.get('/x', (c) => c.json({ ok: true }));
  return app;
}

describe('readAuthMiddleware', () => {
  it('401 without / with wrong token; 200 with correct token', async () => {
    const app = appWithToken('secret');
    expect((await app.request('/x')).status).toBe(401);
    expect((await app.request('/x', { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await app.request('/x', { headers: { authorization: 'Bearer secret' } })).status).toBe(200);
  });

  it('401 body uses the unauthorized error envelope', async () => {
    const res = await appWithToken('s').request('/x');
    expect(await res.json()).toEqual({ error: { code: 'unauthorized', message: 'missing or invalid token' } });
  });

  it('safeEqual (hash-based constant-time): equal match, different reject incl. different lengths', () => {
    expect(safeEqual('a', 'ab')).toBe(false);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('', 'x')).toBe(false);
  });
});
