import { describe, it, expect } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import { MastraTurnInterpreter } from './mastra-turn-interpreter.ts';
import { TurnProviderSchema } from '../../chat/turn-provider-schema.ts';
import { normalizeTurnOutput } from '../../chat/normalize-turn-output.ts';
import { TurnInterpretationSchema } from '../../chat/turn-interpretation.ts';
import { loadEnv } from '../../config/env.ts';
import { resolveLanguageModel } from '../llm/model-provider.ts';
import { createTurnInterpreterAgent } from '../../mastra/agents/turn-interpreter.agent.ts';

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

describe('MastraTurnInterpreter (construction)', () => {
  it('stores label and exposes adapter/model metadata', () => {
    const { model, label } = resolveLanguageModel(
      { MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'dummy' },
      'anthropic/claude-haiku-4-5-20251001',
    );
    const { agent } = mockAgent({ object: { subject: 'unknown', constraints: {}, references: [], confidence: 0.5 } });
    // Inline agent construction mirrors how MastraTurnInterpreter works.
    const interp = new MastraTurnInterpreter(agent, label);
    expect(interp.adapter).toBe('mastra');
    expect(interp.model).toBe('anthropic/claude-haiku-4-5-20251001');
  });
});

describe('MastraTurnInterpreter — structured output', () => {
  it('calls generate with TurnProviderSchema and no errorStrategy', async () => {
    const { agent, calls } = mockAgent({
      object: {
        subject: 'strategy',
        goal: null,
        strategyText: 'buy on breakout',
        constraints: { market: null, symbol: null, timeframe: '1m', direction: 'long' },
        references: [],
        confidence: 0.9,
      },
    });
    const interp = new MastraTurnInterpreter(agent, 'm');
    await interp.interpret('стратегия');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.structuredOutput?.schema).toBe(TurnProviderSchema);
    expect(calls[0]!.options.structuredOutput?.errorStrategy).toBeUndefined();
  });

  it('returns raw provider object (may contain nulls — not yet normalized)', async () => {
    const providerOutput = {
      subject: 'strategy',
      goal: null,
      strategyText: null,
      constraints: { market: null, symbol: null, timeframe: '5m', direction: 'short' },
      references: [],
      confidence: 0.85,
    };
    const { agent } = mockAgent({ object: providerOutput });
    const interp = new MastraTurnInterpreter(agent, 'm');
    const raw = await interp.interpret('шорт на 5m');
    // Raw output is returned as-is (nulls intact); normalization is caller's responsibility.
    expect(raw).toEqual(providerOutput);
  });

  it('provider output with nullable nested fields normalizes + validates via TurnInterpretationSchema', async () => {
    const providerOutput = {
      subject: 'strategy',
      goal: null,
      strategyText: 'лонг при росте OI',
      constraints: { market: null, symbol: null, timeframe: '1m', direction: 'long' },
      references: [],
      confidence: 0.9,
    };
    const { agent } = mockAgent({ object: providerOutput });
    const interp = new MastraTurnInterpreter(agent, 'm');
    const raw = await interp.interpret('стратегия');
    const normalized = normalizeTurnOutput(raw);
    const parsed = TurnInterpretationSchema.parse(normalized);
    expect(parsed.subject).toBe('strategy');
    expect(parsed.goal).toBeUndefined();
    expect(parsed.strategyText).toBe('лонг при росте OI');
    expect(parsed.constraints).toEqual({ timeframe: '1m', direction: 'long' });
    expect(parsed.confidence).toBe(0.9);
  });

  it('propagates errors from the agent', async () => {
    const { agent } = mockAgent(new Error('network error'));
    const interp = new MastraTurnInterpreter(agent, 'm');
    await expect(interp.interpret('test')).rejects.toThrow('network error');
  });
});

const env = loadEnv();
const live = env.RUN_LLM_TESTS && env.ANTHROPIC_API_KEY ? describe : describe.skip;

live('MastraTurnInterpreter (live LLM)', () => {
  it('interprets a strategy message', async () => {
    const { model, label } = resolveLanguageModel(env, env.TURN_INTERPRETER_MODEL);
    const agent = createTurnInterpreterAgent(model);
    const interp = new MastraTurnInterpreter(agent, label);
    const raw = await interp.interpret('Лонг на 1m. Вход при росте OI.');
    const normalized = normalizeTurnOutput(raw);
    const parsed = TurnInterpretationSchema.parse(normalized);
    expect(parsed.subject).toBe('strategy');
  }, 60_000);
});
