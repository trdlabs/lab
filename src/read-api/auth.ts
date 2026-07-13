import type { MiddlewareHandler } from 'hono';
import { bearerAuth } from '../auth/bearer-auth.ts';

// Re-exported so existing importers of this module (read-api/auth.test.ts) keep resolving safeEqual here.
export { safeEqual } from '../auth/bearer.ts';

// Fail-closed read-surface gate. Delegates to the shared bearerAuth factory so an unset/empty read
// token yields 503 (boundary not configured) rather than the previous bypass: parseBearer('Bearer ')
// === '' and safeEqual('','') === true let `Authorization: Bearer ` through with 200 (P1-19).
export function readAuthMiddleware(token: string | undefined): MiddlewareHandler {
  return bearerAuth(token, {
    notConfiguredMessage: 'read API not configured (TRADING_LAB_READ_TOKEN unset)',
  });
}
