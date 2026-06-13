import type { Hono } from 'hono';
import type { AgentActivityProjection } from '../projection.ts';
import type { AgentId } from '../agent-taxonomy.ts';

export interface AgentRouteDeps {
  projection: AgentActivityProjection;
}

export function registerAgentRoutes(app: Hono, deps: AgentRouteDeps): void {
  app.get('/agents', (c) => c.json(deps.projection.snapshot()));
  app.get('/agents/:agentId', (c) => {
    const activity = deps.projection.getAgent(c.req.param('agentId') as AgentId);
    if (!activity) return c.json({ error: { code: 'not_found', message: 'unknown agent' } }, 404);
    return c.json(activity);
  });
}
