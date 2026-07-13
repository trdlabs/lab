export type ChatLimitReason = 'rate_limited' | 'concurrent_request';
export type ChatLimitDecision = { ok: true } | { ok: false; reason: ChatLimitReason };

export interface ChatRateLimiterDeps {
  /** Max turns served per window across ALL sessions on this instance. <= 0 disables the limiter entirely. */
  maxTurns: number;
  /** Fixed-window length in ms. */
  windowMs: number;
  /** Injectable clock (ms since epoch). Defaults to Date.now. */
  now?: () => number;
}

/**
 * In-memory guard for the chat boundary (P1-22). Two independent caps on chat LLM work:
 *   - a global fixed-window turn cap (the runaway-spend valve — a leaked chat token or a looping
 *     client can otherwise drive unbounded model calls, invisible to the per-correlationId budget
 *     because every turn mints a fresh chatRequestId);
 *   - a per-session single-flight lock (a session serves one turn at a time).
 * Per-instance only; a multi-process chat tier would need a shared (Redis) counter — a follow-up.
 */
export class ChatRateLimiter {
  private readonly maxTurns: number;
  private readonly windowMs: number;
  private readonly clock: () => number;
  private windowStart: number;
  private windowCount = 0;
  private readonly inFlight = new Set<string>();

  constructor(deps: ChatRateLimiterDeps) {
    this.maxTurns = deps.maxTurns;
    this.windowMs = deps.windowMs;
    this.clock = deps.now ?? Date.now;
    this.windowStart = this.clock();
  }

  /**
   * Reserve a turn slot for `sessionId`: global window cap first, then per-session single-flight.
   * On `{ ok: true }` the caller MUST call `release(sessionId)` once the turn finishes (finally).
   * A disabled limiter (maxTurns <= 0) always returns `{ ok: true }` and tracks nothing.
   */
  acquire(sessionId: string): ChatLimitDecision {
    if (this.maxTurns <= 0) return { ok: true };
    const t = this.clock();
    if (t - this.windowStart >= this.windowMs) {
      this.windowStart = t;
      this.windowCount = 0;
    }
    if (this.windowCount >= this.maxTurns) return { ok: false, reason: 'rate_limited' };
    // Checked AFTER the window cap but BEFORE incrementing, so a concurrency-blocked turn never
    // consumes window budget.
    if (this.inFlight.has(sessionId)) return { ok: false, reason: 'concurrent_request' };
    this.windowCount += 1;
    this.inFlight.add(sessionId);
    return { ok: true };
  }

  release(sessionId: string): void {
    this.inFlight.delete(sessionId);
  }
}
