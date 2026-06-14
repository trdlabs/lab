import { Hono, type Context } from 'hono';
import type { ReadApiDeps } from './deps.ts';
import { readAuthMiddleware } from './auth.ts';
import { InvalidCursorError } from './pagination.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerHypothesisRoutes } from './routes/hypotheses.ts';
import { registerBacktestRoutes } from './routes/backtests.ts';
import { registerAgentEventRoutes } from './routes/agent-events.ts';
import { registerAgentRoutes } from './routes/agents.ts';
import { registerStreamRoutes } from './routes/stream.ts';

const V1_PATHS = ['/hypotheses', '/hypotheses/:id', '/backtests', '/backtests/:id', '/agent-events', '/agents', '/agents/:agentId', '/stream'];

export function createReadApp(deps: ReadApiDeps): Hono {
  const app = new Hono();

  app.onError((err, c: Context) => {
    if (err instanceof InvalidCursorError) {
      return c.json({ error: { code: 'bad_request', message: 'invalid cursor' } }, 400);
    }
    return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
  });

  // open probes
  registerHealthRoutes(app, deps);

  // gated read surface
  const v1 = new Hono();
  v1.use('*', readAuthMiddleware(deps.token));
  registerHypothesisRoutes(v1, deps);
  registerBacktestRoutes(v1, deps);
  registerAgentEventRoutes(v1, deps);
  registerAgentRoutes(v1, deps);
  registerStreamRoutes(v1, {
    agentEvents: deps.agentEvents,
    agentStream: deps.agentStream,
    heartbeatMs: deps.streamHeartbeatMs,
    getLiveCursor: () => deps.projection.cursorKey(),
  });

  // Explicit 405 — Hono would otherwise 404 an unmatched method on a known path.
  const methodNotAllowed = (c: Context) => c.json({ error: { code: 'method_not_allowed', message: 'method not allowed' } }, 405);
  for (const p of V1_PATHS) v1.on(['POST', 'PUT', 'PATCH', 'DELETE'], p, methodNotAllowed);

  app.route('/v1', v1);
  return app;
}
