// src/adapters/llm/model-provider.test.ts
import { describe, it, expect } from 'vitest';
import { parseRoleModel, type ModelProviderEnv } from './model-provider.ts';

function env(MODEL_PROVIDER: ModelProviderEnv['MODEL_PROVIDER']): ModelProviderEnv {
  return { MODEL_PROVIDER };
}

describe('parseRoleModel', () => {
  const cases: Array<[string, ModelProviderEnv['MODEL_PROVIDER'], string, string]> = [
    // roleModelId,                              MODEL_PROVIDER, provider,     modelId
    ['claude-sonnet-4-6',                        'anthropic',  'anthropic',  'claude-sonnet-4-6'],
    ['anthropic/claude-sonnet-4-6',              'openai',     'anthropic',  'claude-sonnet-4-6'],
    ['openai/gpt-4o',                            'anthropic',  'openai',     'gpt-4o'],
    ['gpt-4o',                                   'openai',     'openai',     'gpt-4o'],
    ['meta-llama/llama-3.1-70b',                 'openrouter', 'openrouter', 'meta-llama/llama-3.1-70b'],
    ['openrouter/anthropic/claude-3.5-sonnet',   'anthropic',  'openrouter', 'anthropic/claude-3.5-sonnet'],
    ['google/gemini-flash-1.5',                  'anthropic',  'anthropic',  'google/gemini-flash-1.5'],
  ];

  for (const [roleModelId, provider, expProvider, expModelId] of cases) {
    it(`${roleModelId} @ ${provider} -> ${expProvider}:${expModelId}`, () => {
      const r = parseRoleModel(env(provider), roleModelId);
      expect(r.provider).toBe(expProvider);
      expect(r.modelId).toBe(expModelId);
    });
  }
});

import { resolveLanguageModel } from './model-provider.ts';

describe('resolveLanguageModel', () => {
  it('resolves provider/modelId/label and returns an opaque model (openai)', () => {
    const r = resolveLanguageModel({ MODEL_PROVIDER: 'openai', OPENAI_API_KEY: 'dummy' }, 'gpt-4o');
    expect(r.provider).toBe('openai');
    expect(r.modelId).toBe('gpt-4o');
    expect(r.label).toBe('gpt-4o');
    expect(r.model).toBeDefined(); // model is opaque — do NOT assert provider-internal fields
  });

  it('per-role prefix overrides the global provider, label keeps the original id', () => {
    const r = resolveLanguageModel({ MODEL_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' }, 'anthropic/claude-sonnet-4-6');
    expect(r.provider).toBe('anthropic');
    expect(r.modelId).toBe('claude-sonnet-4-6');
    expect(r.label).toBe('anthropic/claude-sonnet-4-6');
  });

  it('openrouter vendor id falls through to global MODEL_PROVIDER=openrouter', () => {
    const r = resolveLanguageModel({ MODEL_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k' }, 'meta-llama/llama-3.1-70b-instruct');
    expect(r.provider).toBe('openrouter');
    expect(r.modelId).toBe('meta-llama/llama-3.1-70b-instruct');
  });

  it('throws a clear error when the selected provider key is missing', () => {
    expect(() => resolveLanguageModel({ MODEL_PROVIDER: 'anthropic' }, 'claude-sonnet-4-6')).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => resolveLanguageModel({ MODEL_PROVIDER: 'openai' }, 'gpt-4o')).toThrow(/OPENAI_API_KEY/);
    expect(() => resolveLanguageModel({ MODEL_PROVIDER: 'openrouter' }, 'x/y')).toThrow(/OPENROUTER_API_KEY/);
  });
});
