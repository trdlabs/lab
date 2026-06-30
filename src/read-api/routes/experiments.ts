import type { Hono } from 'hono';
import type { ReadApiDeps } from '../deps.ts';
import { ExperimentListQuerySchema } from '../dto.ts';
import { toExperimentDto, toExperimentRunMemberDto } from '../mappers.ts';
import { decodeCursor, encodeCursor } from '../pagination.ts';

export function registerExperimentRoutes(app: Hono, deps: ReadApiDeps): void {
  app.get('/experiments', async (c) => {
    const parsed = ExperimentListQuerySchema.safeParse({
      strategyProfileId: c.req.query('strategyProfileId'),
      status: c.req.query('status'),
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
    });
    if (!parsed.success) return c.json({ error: { code: 'bad_request', message: 'invalid query' } }, 400);
    const { strategyProfileId, status, limit, cursor } = parsed.data;
    const after = cursor ? decodeCursor(cursor) : undefined;
    const items = await deps.experiments.list({ strategyProfileId, status, limit, after });
    const data = items.map(toExperimentDto);
    const last = items[items.length - 1];
    const nextCursor = items.length === limit && last ? encodeCursor({ t: last.createdAt, id: last.id }) : null;
    return c.json({ data, page: { nextCursor, limit } });
  });

  app.get('/experiments/:id', async (c) => {
    const e = await deps.experiments.getById(c.req.param('id'));
    if (!e) return c.json({ error: { code: 'not_found', message: 'experiment not found' } }, 404);
    return c.json(toExperimentDto(e));
  });

  app.get('/experiments/:id/runs', async (c) => {
    const e = await deps.experiments.getById(c.req.param('id'));
    if (!e) return c.json({ error: { code: 'not_found', message: 'experiment not found' } }, 404);
    const runs = await deps.experiments.listRuns(c.req.param('id'));
    return c.json({ data: runs.map(toExperimentRunMemberDto) });
  });
}
