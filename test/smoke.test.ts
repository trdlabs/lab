import { describe, it, expect } from 'vitest';
import { loadEnv } from '../src/config/env.ts';

describe('env', () => {
  it('defaults ENABLE_CRITIC_AGENT to false', () => {
    expect(loadEnv({}).ENABLE_CRITIC_AGENT).toBe(false);
  });
  it('parses ENABLE_CRITIC_AGENT=true', () => {
    expect(loadEnv({ ENABLE_CRITIC_AGENT: 'true' }).ENABLE_CRITIC_AGENT).toBe(true);
  });
});
