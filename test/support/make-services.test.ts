import { describe, it, expect } from 'vitest';
import { makeServices } from './make-services.ts';

describe('makeServices — SP-7.2b backend defaults', () => {
  it('defaults research_platform backend, fast poll, v1 baseline', () => {
    const s = makeServices();
    expect(s.backtestBackend).toBe('research_platform');
    expect(s.platformPoll).toEqual({ maxPolls: 5, pollDelayMs: 0 });
    expect(s.baselineVersion).toBe('v1');
  });
  it('honors overrides', () => {
    const s = makeServices({ backtestBackend: 'research_platform', platformPoll: { maxPolls: 2, pollDelayMs: 0 } });
    expect(s.backtestBackend).toBe('research_platform');
    expect(s.platformPoll.maxPolls).toBe(2);
  });
});
