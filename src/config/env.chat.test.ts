import { describe, it, expect } from 'vitest';
import { loadEnv } from './env.ts';

describe('loadEnv — chat config', () => {
  it('defaults keep docker compose key-free', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.INTENT_CLASSIFIER_ADAPTER).toBe('fake');
    expect(env.INTENT_CLASSIFIER_MODEL).toBe('anthropic/claude-haiku-4-5-20251001');
    expect(env.INTENT_CLASSIFIER_MIN_CONFIDENCE).toBe(0.6);
    expect(env.CHAT_MAX_MESSAGE_CHARS).toBe(4000);
  });

  it('parses overrides', () => {
    const env = loadEnv({
      INTENT_CLASSIFIER_ADAPTER: 'mastra',
      INTENT_CLASSIFIER_MODEL: 'openai/gpt-4o-mini',
      INTENT_CLASSIFIER_MIN_CONFIDENCE: '0.8',
      CHAT_MAX_MESSAGE_CHARS: '2000',
    } as NodeJS.ProcessEnv);
    expect(env.INTENT_CLASSIFIER_ADAPTER).toBe('mastra');
    expect(env.INTENT_CLASSIFIER_MODEL).toBe('openai/gpt-4o-mini');
    expect(env.INTENT_CLASSIFIER_MIN_CONFIDENCE).toBe(0.8);
    expect(env.CHAT_MAX_MESSAGE_CHARS).toBe(2000);
  });

  it('falls back to fake for an unknown adapter', () => {
    const env = loadEnv({ INTENT_CLASSIFIER_ADAPTER: 'bogus' } as NodeJS.ProcessEnv);
    expect(env.INTENT_CLASSIFIER_ADAPTER).toBe('fake');
  });
});
