import type { Hono } from 'hono';
import type { ReadApiDeps } from '../deps.ts';
import { CYCLE_SCORECARD_SCHEMA_VERSION } from '../../domain/cycle-scorecard.ts';

export function registerCycleScorecardRoutes(app: Hono, deps: ReadApiDeps): void {
  app.get('/cycles/:correlationId/scorecard', async (c) => {
    const row = await deps.cycleScorecards.findByCorrelationAndSchema(
      c.req.param('correlationId'), CYCLE_SCORECARD_SCHEMA_VERSION,
    );
    if (!row) {
      return c.json({ error: { code: 'not_found', message: 'cycle scorecard not available' } }, 404);
    }
    return c.json(row.payload);
  });
}
