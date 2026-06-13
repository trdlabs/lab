import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

// Constant-time compare: hash both sides to a fixed 32-byte digest first, so timing is
// independent of input length — no early length-mismatch leak (always compares 32 bytes).
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

const PREFIX = 'Bearer ';

export function readAuthMiddleware(token: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    if (!header.startsWith(PREFIX) || !safeEqual(header.slice(PREFIX.length), token)) {
      return c.json({ error: { code: 'unauthorized', message: 'missing or invalid token' } }, 401);
    }
    await next();
  };
}
