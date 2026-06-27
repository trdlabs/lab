import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { registerAgentTraceRoutes } from './agent-traces.ts';
import type { AgentTracesDto } from '../phoenix/trace-dto.ts';

const reader = (out: AgentTracesDto) => ({ getAgentTraces: async () => out });

describe('GET /agents/:agentId/traces', () => {
  it('200 with the reader DTO', async () => {
    const app = new Hono();
    registerAgentTraceRoutes(app, { phoenixTraces: reader({ agentId: 'analyst', reasonCode: null, traces: [] }) });
    const res = await app.request('/agents/analyst/traces');
    expect(res.status).toBe(200);
    expect((await res.json() as AgentTracesDto).agentId).toBe('analyst');
  });

  it('200 + tracing-disabled passes the reason code through (not an error)', async () => {
    const app = new Hono();
    registerAgentTraceRoutes(app, { phoenixTraces: reader({ agentId: 'analyst', reasonCode: 'tracing-disabled', traces: [] }) });
    const res = await app.request('/agents/analyst/traces');
    expect(res.status).toBe(200);
    expect((await res.json() as AgentTracesDto).reasonCode).toBe('tracing-disabled');
  });
});
