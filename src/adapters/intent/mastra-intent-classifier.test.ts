import { describe, it, expect } from 'vitest';
import { MastraIntentClassifier } from './mastra-intent-classifier.ts';
import { ChatIntentSchema } from '../../chat/intent.ts';
import { loadEnv } from '../../config/env.ts';
import { resolveLanguageModel } from '../llm/model-provider.ts';

describe('MastraIntentClassifier (construction)', () => {
  it('stores the label and builds an agent from an injected model', () => {
    const { model, label } = resolveLanguageModel(
      { MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'dummy' },
      'anthropic/claude-haiku-4-5-20251001',
    );
    const c = new MastraIntentClassifier(model, label);
    expect(c.adapter).toBe('mastra');
    expect(c.model).toBe('anthropic/claude-haiku-4-5-20251001');
  });
});

const env = loadEnv();
const live = env.RUN_LLM_TESTS && env.ANTHROPIC_API_KEY ? describe : describe.skip;

live('MastraIntentClassifier (live LLM)', () => {
  it('classifies a weather question as out_of_scope', async () => {
    const { model, label } = resolveLanguageModel(env, env.INTENT_CLASSIFIER_MODEL);
    const c = new MastraIntentClassifier(model, label);
    const raw = await c.classify('какая сегодня погода?');
    const parsed = ChatIntentSchema.parse(raw);
    expect(parsed.intent).toBe('out_of_scope');
  }, 60_000);
});
