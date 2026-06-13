import { describe, it, expect } from 'vitest';
import { createReadApp } from './read-app.ts';
import type { ReadApiDeps } from './deps.ts';
import { InMemoryHypothesisReadAdapter } from '../adapters/read/in-memory-hypothesis-read.adapter.ts';
import { InMemoryBacktestReadAdapter } from '../adapters/read/in-memory-backtest-read.adapter.ts';
import { InMemoryAgentEventReadAdapter } from '../adapters/read/in-memory-agent-event-read.adapter.ts';
import { InMemoryHypothesisReadAdapter as HypAd } from '../adapters/read/in-memory-hypothesis-read.adapter.ts';
import type { HypothesisProposal } from '../domain/hypothesis.ts';
import type { AgentEventRow } from '../ports/agent-event-read.port.ts';

const TOKEN = 'test-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

function deps(over: Partial<ReadApiDeps> = {}): ReadApiDeps {
  return {
    hypotheses: new InMemoryHypothesisReadAdapter([]),
    backtests: new InMemoryBacktestReadAdapter([]),
    agentEvents: new InMemoryAgentEventReadAdapter([]),
    checkReadiness: async () => true,
    token: TOKEN,
    ...over,
  };
}

describe('createReadApp skeleton', () => {
  it('GET /healthz is open and 200', async () => {
    const res = await createReadApp(deps()).request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('GET /readyz reflects checkReadiness', async () => {
    expect((await createReadApp(deps()).request('/readyz')).status).toBe(200);
    const down = await createReadApp(deps({ checkReadiness: async () => false })).request('/readyz');
    expect(down.status).toBe(503);
  });

  it('GET /v1/* requires a token (401 without it)', async () => {
    expect((await createReadApp(deps()).request('/v1/hypotheses')).status).toBe(401);
    // The 200-with-token case needs real routes — it lands in Task 15 (stub routes register no GET here).
  });

  it('non-GET on a /v1 path returns 405 (not 404)', async () => {
    const app = createReadApp(deps());
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await app.request('/v1/hypotheses', { method, headers: AUTH });
      expect(res.status, method).toBe(405);
      expect((await res.json() as { error: { code: string } }).error.code).toBe('method_not_allowed');
    }
  });
});

function hyp(id: string, createdAt: string): HypothesisProposal {
  return {
    id, strategyProfileId: 'p1', thesis: 't', targetBehavior: 'tb',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'x', action: 'skip_entry', params: {} }] },
    requiredFeatures: [], validationPlan: 'p', expectedEffect: { metric: 'pnl', direction: 'increase' },
    invalidationCriteria: ['c'], confidence: 0.5, status: 'validated', fingerprint: 'fp', proposal: {} as HypothesisProposal['proposal'],
    issues: [], contractVersion: 'v1', createdAt, updatedAt: createdAt,
  };
}

describe('routes', () => {
  it('GET /v1/hypotheses returns envelope + keyset nextCursor', async () => {
    const seed = [hyp('h1', '2026-01-01T00:00:01.000Z'), hyp('h2', '2026-01-01T00:00:02.000Z'), hyp('h3', '2026-01-01T00:00:03.000Z')];
    const app = createReadApp(deps({ hypotheses: new HypAd(seed) }));
    const res = await app.request('/v1/hypotheses?limit=2', { headers: AUTH });
    const body = await res.json() as { data: { id: string }[]; page: { nextCursor: string } };
    expect(body.data.map((h) => h.id)).toEqual(['h3', 'h2']);
    expect(body.page.nextCursor).toBeTruthy();
    const res2 = await app.request(`/v1/hypotheses?limit=2&cursor=${encodeURIComponent(body.page.nextCursor)}`, { headers: AUTH });
    expect((await res2.json() as { data: { id: string }[] }).data.map((h) => h.id)).toEqual(['h1']);
  });

  it('GET /v1/hypotheses/:id → 200 / 404', async () => {
    const app = createReadApp(deps({ hypotheses: new HypAd([hyp('h1', '2026-01-01T00:00:01.000Z')]) }));
    expect((await app.request('/v1/hypotheses/h1', { headers: AUTH })).status).toBe(200);
    const miss = await app.request('/v1/hypotheses/nope', { headers: AUTH });
    expect(miss.status).toBe(404);
    expect((await miss.json() as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('malformed cursor → 400 bad_request, no internal leak (R9.1)', async () => {
    const app = createReadApp(deps());
    const res = await app.request('/v1/hypotheses?cursor=%%%bad', { headers: AUTH });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: { code: 'bad_request', message: 'invalid cursor' } });
  });

  it('invalid query (bad limit) → 400', async () => {
    const res = await createReadApp(deps()).request('/v1/backtests?limit=999', { headers: AUTH });
    expect(res.status).toBe(400);
  });

  it('GET /v1/agent-events sanitizes payload', async () => {
    const rows: AgentEventRow[] = [{ id: 'e1', taskId: 't1', type: 'some.unknown', payload: { secret: 'X' }, createdAt: '2026-01-01T00:00:01.000Z' }];
    const { InMemoryAgentEventReadAdapter } = await import('../adapters/read/in-memory-agent-event-read.adapter.ts');
    const res = await createReadApp(deps({ agentEvents: new InMemoryAgentEventReadAdapter(rows) })).request('/v1/agent-events', { headers: AUTH });
    const body = await res.json() as { data: Record<string, unknown>[] };
    expect(body.data[0]!.payloadSummary).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('X');
  });
});
