import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { registerAgentRoutes } from './agents.ts';
import { AgentActivityProjection } from '../projection.ts';
import type { AgentEventRow } from '../../ports/agent-event-read.port.ts';

function appWith(p: AgentActivityProjection): Hono {
  const app = new Hono();
  registerAgentRoutes(app, { projection: p });
  return app;
}
const ev = (id: string, type: string): AgentEventRow => ({ id, taskId: 't1', type, payload: {}, createdAt: `2026-01-01T00:00:0${id}.000Z` });

describe('GET /agents', () => {
  it('returns the four known agents + a cursor', async () => {
    const p = new AgentActivityProjection(50);
    p.apply(ev('1', 'researcher.started'));
    const res = await appWith(p).request('/agents');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { agentId: string; status: string }[]; cursor: string | null };
    expect(body.data.map((a) => a.agentId)).toEqual(['analyst', 'researcher', 'critic', 'builder']);
    expect(body.data.find((a) => a.agentId === 'researcher')!.status).toBe('working');
    expect(body.cursor).toBeTruthy();
  });

  it('returns a null cursor when empty', async () => {
    const res = await appWith(new AgentActivityProjection(50)).request('/agents');
    expect((await res.json() as { cursor: string | null }).cursor).toBeNull();
  });
});

describe('GET /agents/:agentId', () => {
  it('200 for a known agent', async () => {
    const res = await appWith(new AgentActivityProjection(50)).request('/agents/researcher');
    expect(res.status).toBe(200);
    expect((await res.json() as { agentId: string }).agentId).toBe('researcher');
  });
  it('404 for an unknown agent', async () => {
    const res = await appWith(new AgentActivityProjection(50)).request('/agents/ghost');
    expect(res.status).toBe(404);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('not_found');
  });
});
