import { describe, it, expect } from 'vitest';
import { loadEnv } from './env.ts';

describe('loadEnv — chat config', () => {
  it('defaults keep docker compose key-free', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.TURN_INTERPRETER_ADAPTER).toBe('fake');
    expect(env.TURN_INTERPRETER_MODEL).toBe('openrouter/google/gemini-3.1-flash-lite');
    expect(env.TURN_INTERPRETER_MIN_CONFIDENCE).toBe(0.6);
    expect(env.CHAT_MAX_MESSAGE_CHARS).toBe(4000);
  });

  it('parses overrides', () => {
    const env = loadEnv({
      TURN_INTERPRETER_ADAPTER: 'mastra',
      TURN_INTERPRETER_MODEL: 'openai/gpt-4o-mini',
      TURN_INTERPRETER_MIN_CONFIDENCE: '0.8',
      CHAT_MAX_MESSAGE_CHARS: '2000',
    } as NodeJS.ProcessEnv);
    expect(env.TURN_INTERPRETER_ADAPTER).toBe('mastra');
    expect(env.TURN_INTERPRETER_MODEL).toBe('openai/gpt-4o-mini');
    expect(env.TURN_INTERPRETER_MIN_CONFIDENCE).toBe(0.8);
    expect(env.CHAT_MAX_MESSAGE_CHARS).toBe(2000);
  });

  it('falls back to fake for an unknown adapter', () => {
    const env = loadEnv({ TURN_INTERPRETER_ADAPTER: 'bogus' } as NodeJS.ProcessEnv);
    expect(env.TURN_INTERPRETER_ADAPTER).toBe('fake');
  });
});
