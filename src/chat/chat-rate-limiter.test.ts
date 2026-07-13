import { describe, it, expect } from 'vitest';
import { ChatRateLimiter } from './chat-rate-limiter.ts';

// Injectable clock so window rollover is deterministic (no wall-clock, no sleeps).
function makeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('ChatRateLimiter', () => {
  it('allows up to maxTurns within a window, then rate_limits further turns', () => {
    const limiter = new ChatRateLimiter({ maxTurns: 3, windowMs: 60_000 });
    // distinct sessions so the per-session lock never fires — this isolates the global window cap
    expect(limiter.acquire('s1')).toEqual({ ok: true });
    expect(limiter.acquire('s2')).toEqual({ ok: true });
    expect(limiter.acquire('s3')).toEqual({ ok: true });
    expect(limiter.acquire('s4')).toEqual({ ok: false, reason: 'rate_limited' });
  });

  it('resets the window after windowMs elapses', () => {
    const clock = makeClock();
    const limiter = new ChatRateLimiter({ maxTurns: 1, windowMs: 60_000, now: clock.now });
    expect(limiter.acquire('s1')).toEqual({ ok: true });
    expect(limiter.acquire('s2')).toEqual({ ok: false, reason: 'rate_limited' });
    clock.advance(60_000);
    expect(limiter.acquire('s3')).toEqual({ ok: true });
  });

  it('blocks a second concurrent turn for the same session until release', () => {
    const limiter = new ChatRateLimiter({ maxTurns: 100, windowMs: 60_000 });
    expect(limiter.acquire('sess')).toEqual({ ok: true });
    expect(limiter.acquire('sess')).toEqual({ ok: false, reason: 'concurrent_request' });
    limiter.release('sess');
    expect(limiter.acquire('sess')).toEqual({ ok: true });
  });

  it('a concurrency-blocked turn does not consume window budget', () => {
    const limiter = new ChatRateLimiter({ maxTurns: 2, windowMs: 60_000 });
    expect(limiter.acquire('a')).toEqual({ ok: true });
    expect(limiter.acquire('a')).toEqual({ ok: false, reason: 'concurrent_request' }); // must NOT count
    expect(limiter.acquire('b')).toEqual({ ok: true }); // 2nd real slot still available
  });

  it('lets different sessions run concurrently up to the window cap', () => {
    const limiter = new ChatRateLimiter({ maxTurns: 5, windowMs: 60_000 });
    expect(limiter.acquire('a')).toEqual({ ok: true });
    expect(limiter.acquire('b')).toEqual({ ok: true });
    limiter.release('a');
    expect(limiter.acquire('a')).toEqual({ ok: true });
  });

  it('maxTurns <= 0 disables the limiter entirely (always ok, no concurrency block)', () => {
    const limiter = new ChatRateLimiter({ maxTurns: 0, windowMs: 60_000 });
    expect(limiter.acquire('x')).toEqual({ ok: true });
    expect(limiter.acquire('x')).toEqual({ ok: true }); // no concurrency block when disabled
    expect(limiter.acquire('x')).toEqual({ ok: true });
  });
});
