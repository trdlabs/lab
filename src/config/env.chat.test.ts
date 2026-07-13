import { describe, it, expect } from 'vitest';
import { loadEnv } from './env.ts';

describe('loadEnv — chat config', () => {
  it('defaults keep docker compose key-free', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.TURN_INTERPRETER_ADAPTER).toBe('fake');
    expect(env.TURN_INTERPRETER_MODEL).toBe('openrouter/google/gemini-3.1-flash-lite');
    expect(env.TURN_INTERPRETER_MIN_CONFIDENCE).toBe(0.6);
    expect(env.CHAT_MAX_MESSAGE_CHARS).toBe(4000);
    // P1-22 rate-limiter defaults (limiter on by default in demo/VPS).
    expect(env.CHAT_RATE_MAX_TURNS).toBe(30);
    expect(env.CHAT_RATE_WINDOW_MS).toBe(60_000);
  });

  it('parses overrides', () => {
    const env = loadEnv({
      TURN_INTERPRETER_ADAPTER: 'mastra',
      TURN_INTERPRETER_MODEL: 'openai/gpt-4o-mini',
      TURN_INTERPRETER_MIN_CONFIDENCE: '0.8',
      CHAT_MAX_MESSAGE_CHARS: '2000',
      CHAT_RATE_MAX_TURNS: '10',
      CHAT_RATE_WINDOW_MS: '30000',
    } as NodeJS.ProcessEnv);
    expect(env.TURN_INTERPRETER_ADAPTER).toBe('mastra');
    expect(env.TURN_INTERPRETER_MODEL).toBe('openai/gpt-4o-mini');
    expect(env.TURN_INTERPRETER_MIN_CONFIDENCE).toBe(0.8);
    expect(env.CHAT_MAX_MESSAGE_CHARS).toBe(2000);
    expect(env.CHAT_RATE_MAX_TURNS).toBe(10);
    expect(env.CHAT_RATE_WINDOW_MS).toBe(30_000);
  });

  it('[P1-22] CHAT_RATE_MAX_TURNS=0 disables the limiter (explicit 0 is honored, not coerced to default)', () => {
    const env = loadEnv({ CHAT_RATE_MAX_TURNS: '0' } as NodeJS.ProcessEnv);
    expect(env.CHAT_RATE_MAX_TURNS).toBe(0);
  });

  it('[P1-22] empty CHAT_RATE_* (docker `${VAR:-}` passthrough when unset) falls back to defaults, not 0', () => {
    // The compose env block passes ${CHAT_RATE_MAX_TURNS:-} — an EMPTY string when the operator
    // hasn't set it. That must NOT read as 0 (which would silently disable the limiter in demo/VPS).
    const env = loadEnv({ CHAT_RATE_MAX_TURNS: '', CHAT_RATE_WINDOW_MS: '' } as NodeJS.ProcessEnv);
    expect(env.CHAT_RATE_MAX_TURNS).toBe(30);
    expect(env.CHAT_RATE_WINDOW_MS).toBe(60_000);
  });

  it('[P1-17] rejects an unknown TURN_INTERPRETER_ADAPTER (fail-closed, no silent fake)', () => {
    expect(() => loadEnv({ TURN_INTERPRETER_ADAPTER: 'bogus' } as NodeJS.ProcessEnv)).toThrow(/TURN_INTERPRETER_ADAPTER/);
  });
});
