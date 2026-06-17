import { describe, it, expect } from 'vitest';
import { OpsReadClient, OpsReadError, type FetchLike } from './ops-read-client.ts';

function fakeFetch(handler: (url: string, init?: { headers?: Record<string, string> }) => { ok: boolean; status: number; body: unknown }): FetchLike {
  return async (url, init) => {
    const r = handler(url, init);
    return { ok: r.ok, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  };
}

describe('OpsReadClient', () => {
  it('GETs with a Bearer header and parses JSON', async () => {
    let seenUrl = ''; let seenAuth: string | undefined;
    const client = new OpsReadClient({
      baseUrl: 'http://host:8839/', token: 'raw-tok',
      fetchImpl: fakeFetch((url, init) => { seenUrl = url; seenAuth = init?.headers?.authorization; return { ok: true, status: 200, body: { items: [], nextCursor: null } }; }),
    });
    const out = await client.get<{ items: unknown[]; nextCursor: string | null }>('/ops/runs');
    expect(seenUrl).toBe('http://host:8839/ops/runs'); // trailing slash on baseUrl stripped
    expect(seenAuth).toBe('Bearer raw-tok');
    expect(out.nextCursor).toBeNull();
  });

  it('omits the auth header when the token is empty (loopback-open)', async () => {
    let seenAuth: string | undefined = 'unset';
    const client = new OpsReadClient({
      baseUrl: 'http://host:8839', token: '',
      fetchImpl: fakeFetch((_url, init) => { seenAuth = init?.headers?.authorization; return { ok: true, status: 200, body: {} }; }),
    });
    await client.get('/ops/discover');
    expect(seenAuth).toBeUndefined();
  });

  it('throws OpsReadError on a non-2xx response, carrying status + code', async () => {
    const client = new OpsReadClient({
      baseUrl: 'http://host:8839', token: 't',
      fetchImpl: fakeFetch(() => ({ ok: false, status: 404, body: { category: 'not_found', code: 'run_not_found', message: 'no run' } })),
    });
    // Capture the rejection so the field assertions can't be silently skipped if get() ever resolves.
    const err = await client.get('/ops/runs/x/summary').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpsReadError);
    expect((err as OpsReadError).status).toBe(404);
    expect((err as OpsReadError).code).toBe('run_not_found');
  });
});
