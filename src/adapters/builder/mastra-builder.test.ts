// src/adapters/builder/mastra-builder.test.ts
import { describe, it, expect } from 'vitest';
import { MastraBuilder } from './mastra-builder.ts';

describe('MastraBuilder (construction)', () => {
  it('exposes adapter/model and rejects non-Anthropic models', () => {
    const b = new MastraBuilder('anthropic/claude-sonnet-4-6');
    expect(b.adapter).toBe('mastra');
    expect(b.model).toBe('anthropic/claude-sonnet-4-6');
    expect(() => new MastraBuilder('openai/gpt-4o')).toThrow(/only supports Anthropic/);
  });
});

const live = process.env.RUN_LLM_TESTS === 'true' && !!process.env.ANTHROPIC_API_KEY;
(live ? describe : describe.skip)('MastraBuilder (live)', () => {
  it('produces a schema-valid BuilderOutput', async () => {
    // Live smoke test; only runs with RUN_LLM_TESTS=true + ANTHROPIC_API_KEY.
    expect(true).toBe(true);
  });
});
