import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { Agent } from '@mastra/core/agent';
import { MastraIntentClassifier } from './mastra-intent-classifier.ts';
import { ChatIntentSchema } from '../../chat/intent.ts';
import { ChatIntentProviderSchema } from '../../chat/intent-provider-schema.ts';
import { loadEnv } from '../../config/env.ts';
import { resolveLanguageModel } from '../llm/model-provider.ts';
import { createIntentClassifierAgent } from '../../mastra/agents/intent-classifier.agent.ts';

describe('MastraIntentClassifier (construction)', () => {
  it('stores the label and builds an agent from an injected model', () => {
    const { model, label } = resolveLanguageModel(
      { MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'dummy' },
      'anthropic/claude-haiku-4-5-20251001',
    );
    const c = new MastraIntentClassifier(createIntentClassifierAgent(model), label);
    expect(c.adapter).toBe('mastra');
    expect(c.model).toBe('anthropic/claude-haiku-4-5-20251001');
  });
});

type GenArgs = { prompt: string; options: { structuredOutput?: { schema?: unknown; errorStrategy?: string } } };

/** A stand-in Agent whose generate() records its call args and returns a canned result. */
function mockAgent(result: unknown): { agent: Agent; calls: GenArgs[] } {
  const calls: GenArgs[] = [];
  const agent = {
    async generate(prompt: string, options: GenArgs['options']) {
      calls.push({ prompt, options });
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as Agent;
  return { agent, calls };
}

describe('MastraIntentClassifier — strict (production default) path', () => {
  it('validates inside Mastra (no errorStrategy) and returns result.object', async () => {
    const { agent, calls } = mockAgent({ object: { intent: 'help', confidence: 0.9 } });
    const c = new MastraIntentClassifier(agent, 'm');
    const out = await c.classify('hi');
    expect(out).toEqual({ intent: 'help', confidence: 0.9 });
    expect(calls[0]!.options.structuredOutput?.schema).toBe(ChatIntentProviderSchema);
    expect(calls[0]!.options.structuredOutput?.errorStrategy).toBeUndefined();
  });

  it('strips null optional fields before returning (OpenAI-compatible provider output)', async () => {
    const { agent } = mockAgent({
      object: {
        intent: 'strategy.onboard', confidence: 0.9,
        strategyText: 'лонг на отскоке', hypothesisText: null, entityRef: null,
        taskIdHint: null, requestedOutcome: 'onboard', rationale: null,
      },
    });
    const c = new MastraIntentClassifier(agent, 'm');
    expect(await c.classify('стратегия')).toEqual({
      intent: 'strategy.onboard', confidence: 0.9,
      strategyText: 'лонг на отскоке', requestedOutcome: 'onboard',
    });
  });

  it('propagates a Mastra validation throw (production behaviour preserved)', async () => {
    const { agent } = mockAgent(new Error('STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED'));
    const c = new MastraIntentClassifier(agent, 'm');
    await expect(c.classify('hi')).rejects.toThrow(/SCHEMA_VALIDATION_FAILED/);
  });
});

describe('MastraIntentClassifier — raw (eval) path', () => {
  it('uses errorStrategy:"warn" so Mastra never throws on a schema deviation', async () => {
    const { agent, calls } = mockAgent({ object: { intent: 'help', confidence: 0.9 } });
    const c = new MastraIntentClassifier(agent, 'm', { schemaValidation: 'raw' });
    await c.classify('hi');
    expect(calls[0]!.options.structuredOutput?.errorStrategy).toBe('warn');
  });

  it('forwards a provided requestSchema to the model (OpenAI-compatible schema)', async () => {
    const { agent, calls } = mockAgent({ object: { intent: 'help', confidence: 0.9 } });
    const evalSchema = z.object({ intent: z.string() }); // stand-in for the OpenAI-strict variant
    const c = new MastraIntentClassifier(agent, 'm', { schemaValidation: 'raw', requestSchema: evalSchema });
    await c.classify('hi');
    expect(calls[0]!.options.structuredOutput?.schema).toBe(evalSchema);
  });

  it('returns the validated object when one is present', async () => {
    const { agent } = mockAgent({ object: { intent: 'help', confidence: 0.9 } });
    const c = new MastraIntentClassifier(agent, 'm', { schemaValidation: 'raw' });
    expect(await c.classify('hi')).toEqual({ intent: 'help', confidence: 0.9 });
  });

  it('recovers the raw model JSON from result.text when object is absent (invalid enum) — keeps intent visible', async () => {
    // entityRef "from_message" is an invalid enum -> Mastra warns, object is undefined, raw is in text.
    const { agent } = mockAgent({ object: undefined, text: '{"intent":"strategy.onboard","confidence":0.8,"entityRef":"from_message"}' });
    const c = new MastraIntentClassifier(agent, 'm', { schemaValidation: 'raw' });
    const out = await c.classify('заведи стратегию: x');
    expect(out).toEqual({ intent: 'strategy.onboard', confidence: 0.8, entityRef: 'from_message' });
  });

  it('strips code fences when recovering raw JSON from text', async () => {
    const { agent } = mockAgent({ object: undefined, text: '```json\n{"intent":"out_of_scope","confidence":0.9}\n```' });
    const c = new MastraIntentClassifier(agent, 'm', { schemaValidation: 'raw' });
    expect(await c.classify('погода')).toEqual({ intent: 'out_of_scope', confidence: 0.9 });
  });

  it('returns the raw string when text is not parseable JSON (harness will mark it schema-invalid)', async () => {
    const { agent } = mockAgent({ object: undefined, text: 'I cannot classify this' });
    const c = new MastraIntentClassifier(agent, 'm', { schemaValidation: 'raw' });
    expect(await c.classify('???')).toBe('I cannot classify this');
  });
});

const env = loadEnv();
const live = env.RUN_LLM_TESTS && env.ANTHROPIC_API_KEY ? describe : describe.skip;

live('MastraIntentClassifier (live LLM)', () => {
  it('classifies a weather question as out_of_scope', async () => {
    const { model, label } = resolveLanguageModel(env, env.INTENT_CLASSIFIER_MODEL);
    const c = new MastraIntentClassifier(createIntentClassifierAgent(model), label);
    const raw = await c.classify('какая сегодня погода?');
    const parsed = ChatIntentSchema.parse(raw);
    expect(parsed.intent).toBe('out_of_scope');
  }, 60_000);
});
