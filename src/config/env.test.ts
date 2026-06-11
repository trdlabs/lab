import { describe, it, expect } from 'vitest';
import { loadEnv } from './env.ts';
import { DEFAULT_EVALUATOR_THRESHOLDS } from '../validation/evaluator.ts';

describe('loadEnv SP-3 fields', () => {
  it('defaults researcher and critic to fake and bounds hypotheses', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.RESEARCHER_ADAPTER).toBe('fake');
    expect(env.CRITIC_ADAPTER).toBe('fake');
    expect(env.MAX_HYPOTHESES_PER_CYCLE).toBe(5);
  });

  it('honors overrides and rejects non-positive guardrails', () => {
    const env = loadEnv({ RESEARCHER_ADAPTER: 'mastra', MAX_HYPOTHESES_PER_CYCLE: '0' } as NodeJS.ProcessEnv);
    expect(env.RESEARCHER_ADAPTER).toBe('mastra');
    expect(env.MAX_HYPOTHESES_PER_CYCLE).toBe(5); // 0 is invalid -> fallback
  });
});

describe('SP-4 env', () => {
  it('defaults builder + thresholds', () => {
    const env = loadEnv({});
    expect(env.BUILDER_ADAPTER).toBe('fake');
    expect(env.BUILDER_MODEL).toBe('anthropic/claude-sonnet-4-6');
    expect(env.evaluatorThresholds).toEqual(DEFAULT_EVALUATOR_THRESHOLDS);
  });

  it('reads builder + threshold overrides', () => {
    const env = loadEnv({ BUILDER_ADAPTER: 'mastra', EVAL_MIN_TRADES: '40', EVAL_STRONG_PNL_DELTA_USD: '500', EVAL_MIN_PROFIT_FACTOR: '1.8' });
    expect(env.BUILDER_ADAPTER).toBe('mastra');
    expect(env.evaluatorThresholds.minTrades).toBe(40);
    expect(env.evaluatorThresholds.strongPnlDeltaUsd).toBe(500);
    expect(env.evaluatorThresholds.minProfitFactor).toBe(1.8);
  });
});

describe('SP-4.5 model provider env', () => {
  it('defaults MODEL_PROVIDER to anthropic, keys undefined', () => {
    const env = loadEnv({});
    expect(env.MODEL_PROVIDER).toBe('anthropic');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it('reads MODEL_PROVIDER + provider keys', () => {
    const env = loadEnv({ MODEL_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-o', OPENROUTER_API_KEY: 'sk-or' });
    expect(env.MODEL_PROVIDER).toBe('openai');
    expect(env.OPENAI_API_KEY).toBe('sk-o');
    expect(env.OPENROUTER_API_KEY).toBe('sk-or');
  });

  it('falls back to anthropic for an unknown MODEL_PROVIDER value', () => {
    expect(loadEnv({ MODEL_PROVIDER: 'bogus' }).MODEL_PROVIDER).toBe('anthropic');
  });
});
