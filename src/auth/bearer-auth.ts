import type { MiddlewareHandler } from 'hono';
import { parseBearer, safeEqual } from './bearer.ts';

export interface BearerAuthOptions {
  /** 503 body message when this boundary's token is unset (per-boundary operator signal). */
  notConfiguredMessage: string;
}

// Narrow, route-scoped service-token gate. Fail-closed:
//   token unset/empty         -> 503 (boundary not configured — an operator signal)
//   token set, bad/no Bearer  -> 401 (caller problem; constant envelope across boundaries)
//   token set, Bearer matches -> next()
// This is a bearer-semantics factory ONLY — not an app-wide auth policy. Boundary ownership
// (which token, which routes, the 503 message) stays with the caller.
export function bearerAuth(token: string | undefined, opts: BearerAuthOptions): MiddlewareHandler {
  return async (c, next) => {
    if (!token) {
      return c.json({ error: { code: 'service_unavailable', message: opts.notConfiguredMessage } }, 503);
    }
    const presented = parseBearer(c.req.header('authorization'));
    if (presented === null || !safeEqual(presented, token)) {
      return c.json({ error: { code: 'unauthorized', message: 'missing or invalid token' } }, 401);
    }
    await next();
  };
}
