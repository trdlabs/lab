import type { MiddlewareHandler } from 'hono';
import { parseBearer, safeEqual } from '../auth/bearer.ts';

// Re-exported so existing importers of this module (read-api/auth.test.ts) keep resolving safeEqual here.
export { safeEqual } from '../auth/bearer.ts';

export function readAuthMiddleware(token: string): MiddlewareHandler {
  return async (c, next) => {
    const presented = parseBearer(c.req.header('authorization'));
    if (presented === null || !safeEqual(presented, token)) {
      return c.json({ error: { code: 'unauthorized', message: 'missing or invalid token' } }, 401);
    }
    await next();
  };
}
