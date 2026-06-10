import { describe, it, expect } from 'vitest';
import { MastraStrategyAnalyst } from './mastra-strategy-analyst.ts';
import { AnalystProfileOutputSchema } from '../../domain/strategy-profile.ts';
import { loadEnv } from '../../config/env.ts';

const env = loadEnv();
const live = env.RUN_LLM_TESTS && env.ANTHROPIC_API_KEY ? describe : describe.skip;

describe('MastraStrategyAnalyst (unit)', () => {
  it('reports adapter=mastra and the configured model', () => {
    const a = new MastraStrategyAnalyst('anthropic/claude-sonnet-4-6');
    expect(a.adapter).toBe('mastra');
    expect(a.model).toBe('anthropic/claude-sonnet-4-6');
  });
  it('rejects a non-Anthropic model at construction', () => {
    expect(() => new MastraStrategyAnalyst('openai/gpt-4o')).toThrow(/only supports Anthropic/);
  });
});

live('MastraStrategyAnalyst (live LLM)', () => {
  it('returns a schema-valid profile for a sample source', async () => {
    const a = new MastraStrategyAnalyst(env.STRATEGY_ANALYST_MODEL);
    const out = await a.analyze({
      kind: 'manual_description',
      content: 'Go long when open interest rises while price drops into a liquidation cluster; exit on funding flip.',
    });
    expect(AnalystProfileOutputSchema.safeParse(out).success).toBe(true);
  }, 60_000);
});
