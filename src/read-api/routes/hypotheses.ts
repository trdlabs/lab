import type { Hono } from 'hono';
import type { ReadApiDeps } from '../deps.ts';
import { HypothesisListQuerySchema } from '../dto.ts';
import { toHypothesisListItem, toHypothesisDetail } from '../mappers.ts';
import { decodeCursor, encodeCursor } from '../pagination.ts';

export function registerHypothesisRoutes(app: Hono, deps: ReadApiDeps): void {
  app.get('/hypotheses', async (c) => {
    const parsed = HypothesisListQuerySchema.safeParse({
      status: c.req.query('status'), profileId: c.req.query('profileId'),
      limit: c.req.query('limit'), cursor: c.req.query('cursor'),
    });
    if (!parsed.success) return c.json({ error: { code: 'bad_request', message: 'invalid query' } }, 400);
    const { status, profileId, limit, cursor } = parsed.data;
    const after = cursor ? decodeCursor(cursor) : undefined;
    const items = await deps.hypotheses.list({ status, profileId, limit, after });
    const data = items.map(toHypothesisListItem);
    const last = items[items.length - 1];
    const nextCursor = items.length === limit && last ? encodeCursor({ t: last.createdAt, id: last.id }) : null;
    return c.json({ data, page: { nextCursor, limit } });
  });

  app.get('/hypotheses/:id', async (c) => {
    const h = await deps.hypotheses.getById(c.req.param('id'));
    if (!h) return c.json({ error: { code: 'not_found', message: 'hypothesis not found' } }, 404);
    return c.json(toHypothesisDetail(h));
  });
}
