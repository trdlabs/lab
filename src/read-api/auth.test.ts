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

  it('fail-closed on empty token: `Bearer ` (empty presented) does NOT authenticate — 503, not 200', async () => {
    // P1-19: parseBearer('Bearer ') === '' and safeEqual('','') === true, so an empty configured
    // token used to let `Authorization: Bearer ` through with 200 — opening the whole read surface.
    const app = appWithToken('');
    expect((await app.request('/x', { headers: { authorization: 'Bearer ' } })).status).toBe(503);
    expect((await app.request('/x')).status).toBe(503);
  });

  it('empty-token 503 body uses the service_unavailable envelope', async () => {
    const res = await appWithToken('').request('/x');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'service_unavailable', message: expect.any(String) } });
  });
});
