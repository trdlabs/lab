import type { MiddlewareHandler } from 'hono';
import { parseBearer, safeEqual } from '../auth/bearer.ts';

// Service-to-service gate for the chat ingress. Fail-closed:
//   token unset/empty         -> 503 (boundary not configured — an operator signal)
//   token set, bad/no Bearer  -> 401 (caller problem; same envelope as the read API)
//   token set, Bearer matches -> next()
export function chatAuthMiddleware(token?: string): MiddlewareHandler {
  return async (c, next) => {
    if (!token) {
      return c.json({ error: { code: 'service_unavailable', message: 'chat ingress not configured' } }, 503);
    }
    const presented = parseBearer(c.req.header('authorization'));
    if (presented === null || !safeEqual(presented, token)) {
      return c.json({ error: { code: 'unauthorized', message: 'missing or invalid token' } }, 401);
    }
    await next();
  };
}
