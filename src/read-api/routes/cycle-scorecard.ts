import type { Hono } from 'hono';
import type { ReadApiDeps } from '../deps.ts';
import { CYCLE_SCORECARD_SCHEMA_VERSION } from '../../domain/cycle-scorecard.ts';
import { renderCycleScorecardMarkdown } from '../cycle-scorecard-markdown.ts';
import { CYCLE_SCORECARD_ROUTE } from '../paths.ts';

export function registerCycleScorecardRoutes(app: Hono, deps: ReadApiDeps): void {
  app.get(CYCLE_SCORECARD_ROUTE, async (c) => {
    const row = await deps.cycleScorecards.findByCorrelationAndSchema(
      c.req.param('correlationId'), CYCLE_SCORECARD_SCHEMA_VERSION,
    );
    if (!row) {
      return c.json({ error: { code: 'not_found', message: 'cycle scorecard not available' } }, 404);
    }
    if (c.req.query('format') === 'markdown') {
      return c.body(renderCycleScorecardMarkdown(row.payload), 200, {
        'content-type': 'text/markdown; charset=utf-8',
      });
    }
    return c.json(row.payload);
  });
}
