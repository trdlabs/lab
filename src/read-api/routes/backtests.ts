import type { Hono } from 'hono';
import type { ReadApiDeps } from '../deps.ts';
import { BacktestListQuerySchema } from '../dto.ts';
import { toBacktestDto } from '../mappers.ts';
import { decodeCursor, encodeCursor } from '../pagination.ts';

export function registerBacktestRoutes(app: Hono, deps: ReadApiDeps): void {
  app.get('/backtests', async (c) => {
    const parsed = BacktestListQuerySchema.safeParse({
      hypothesisId: c.req.query('hypothesisId'), status: c.req.query('status'),
      limit: c.req.query('limit'), cursor: c.req.query('cursor'),
    });
    if (!parsed.success) return c.json({ error: { code: 'bad_request', message: 'invalid query' } }, 400);
    const { hypothesisId, status, limit, cursor } = parsed.data;
    const after = cursor ? decodeCursor(cursor) : undefined;
    const items = await deps.backtests.list({ hypothesisId, status, limit, after });
    const data = items.map(toBacktestDto);
    const last = items[items.length - 1];
    const nextCursor = items.length === limit && last ? encodeCursor({ t: last.createdAt, id: last.id }) : null;
    return c.json({ data, page: { nextCursor, limit } });
  });

  app.get('/backtests/:id', async (c) => {
    const b = await deps.backtests.getById(c.req.param('id'));
    if (!b) return c.json({ error: { code: 'not_found', message: 'backtest not found' } }, 404);
    return c.json(toBacktestDto(b));
  });
}
