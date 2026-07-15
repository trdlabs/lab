import { Hono, type Context } from 'hono';
import type { ReadApiDeps } from './deps.ts';
import { readAuthMiddleware } from './auth.ts';
import { InvalidCursorError } from './pagination.ts';
import { registerHealthRoutes, registerAuthzRoute } from './routes/health.ts';
import { registerHypothesisRoutes } from './routes/hypotheses.ts';
import { registerBacktestRoutes } from './routes/backtests.ts';
import { registerAgentEventRoutes } from './routes/agent-events.ts';
import { registerAgentRoutes } from './routes/agents.ts';
import { registerStreamRoutes } from './routes/stream.ts';
import { registerCompletionSummaryRoutes } from './routes/completion-summary.ts';
import { registerAgentTraceRoutes } from './routes/agent-traces.ts';
import { registerExperimentRoutes } from './routes/experiments.ts';
import { registerCycleScorecardRoutes } from './routes/cycle-scorecard.ts';
import { CYCLE_SCORECARD_ROUTE, READ_API_V1_PREFIX } from './paths.ts';

const V1_PATHS = ['/hypotheses', '/hypotheses/:id', '/backtests', '/backtests/:id', '/agent-events', '/agents', '/agents/:agentId', '/stream', '/authz', '/tasks/:taskId/completion-summary', '/experiments', '/experiments/:id', '/experiments/:id/runs', CYCLE_SCORECARD_ROUTE];

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
  registerAuthzRoute(v1); // credential probe — same gate, lets consumers verify their read token
  registerHypothesisRoutes(v1, deps);
  registerBacktestRoutes(v1, deps);
  registerExperimentRoutes(v1, deps);
  registerAgentEventRoutes(v1, deps);
  registerAgentRoutes(v1, deps);
  registerAgentTraceRoutes(v1, deps);
  registerCompletionSummaryRoutes(v1, deps);
  registerCycleScorecardRoutes(v1, deps);
  registerStreamRoutes(v1, {
    agentEvents: deps.agentEvents,
    agentStream: deps.agentStream,
    heartbeatMs: deps.streamHeartbeatMs,
    getLiveCursor: () => deps.projection.cursorKey(),
  });

  // Explicit 405 — Hono would otherwise 404 an unmatched method on a known path.
  const methodNotAllowed = (c: Context) => c.json({ error: { code: 'method_not_allowed', message: 'method not allowed' } }, 405);
  for (const p of V1_PATHS) v1.on(['POST', 'PUT', 'PATCH', 'DELETE'], p, methodNotAllowed);

  app.route(READ_API_V1_PREFIX, v1);
  return app;
}
