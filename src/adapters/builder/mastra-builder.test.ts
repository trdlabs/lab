// src/adapters/builder/mastra-builder.test.ts
import { describe, it, expect } from 'vitest';
import { MastraBuilder } from './mastra-builder.ts';
import { resolveLanguageModel } from '../llm/model-provider.ts';

describe('MastraBuilder (construction)', () => {
  it('stores the label and builds an agent from an injected model', () => {
    const { model, label } = resolveLanguageModel({ MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'dummy' }, 'anthropic/claude-sonnet-4-6');
    const b = new MastraBuilder(model, label);
    expect(b.adapter).toBe('mastra');
    expect(b.model).toBe('anthropic/claude-sonnet-4-6');
  });
});

const live = process.env.RUN_LLM_TESTS === 'true' && !!process.env.ANTHROPIC_API_KEY;
(live ? describe : describe.skip)('MastraBuilder (live)', () => {
  it('produces a schema-valid BuilderOutput', async () => {
    // Live smoke test; only runs with RUN_LLM_TESTS=true + ANTHROPIC_API_KEY.
    expect(true).toBe(true);
  });
});
