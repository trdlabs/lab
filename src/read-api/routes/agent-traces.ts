import type { Hono } from 'hono';
import type { PhoenixTraceReader } from '../phoenix/phoenix-trace-reader.ts';

export interface AgentTraceRouteDeps {
  phoenixTraces: Pick<PhoenixTraceReader, 'getAgentTraces'>;
}

export function registerAgentTraceRoutes(app: Hono, deps: AgentTraceRouteDeps): void {
  app.get('/agents/:agentId/traces', async (c) =>
    c.json(await deps.phoenixTraces.getAgentTraces(c.req.param('agentId'))),
  );
}
