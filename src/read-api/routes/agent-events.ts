import type { Hono } from 'hono';
import type { ReadApiDeps } from '../deps.ts';
import { AgentEventListQuerySchema } from '../dto.ts';
import { toAgentEventDto } from '../mappers.ts';
import { decodeCursor, encodeCursor } from '../pagination.ts';

export function registerAgentEventRoutes(app: Hono, deps: ReadApiDeps): void {
  app.get('/agent-events', async (c) => {
    const parsed = AgentEventListQuerySchema.safeParse({
      taskId: c.req.query('taskId'), type: c.req.query('type'), since: c.req.query('since'),
      correlationId: c.req.query('correlationId'), limit: c.req.query('limit'), cursor: c.req.query('cursor'),
    });
    if (!parsed.success) return c.json({ error: { code: 'bad_request', message: 'invalid query' } }, 400);
    const { taskId, type, since, correlationId, limit, cursor } = parsed.data;
    const after = cursor ? decodeCursor(cursor) : undefined;
    const items = await deps.agentEvents.list({ taskId, type, since, correlationId, limit, after });
    const data = items.map(toAgentEventDto);
    const last = items[items.length - 1];
    const nextCursor = items.length === limit && last ? encodeCursor({ t: last.createdAt, id: last.id }) : null;
    return c.json({ data, page: { nextCursor, limit } });
  });
}
