import { createHash, timingSafeEqual } from 'node:crypto';

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

// Constant-time compare: hash both sides to a fixed 32-byte digest first, so timing is
// independent of input length — no early length-mismatch leak (always compares 32 bytes).
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

const PREFIX = 'Bearer ';

// Extract the token after the "Bearer " prefix; null when the header is absent or malformed.
export function parseBearer(header: string | undefined): string | null {
  if (!header || !header.startsWith(PREFIX)) return null;
  return header.slice(PREFIX.length);
}
