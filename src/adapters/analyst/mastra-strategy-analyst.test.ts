import { describe, it, expect } from 'vitest';
import { MastraStrategyAnalyst } from './mastra-strategy-analyst.ts';
import { AnalystProfileOutputSchema } from '../../domain/strategy-profile.ts';
import { loadEnv } from '../../config/env.ts';
import { resolveLanguageModel } from '../llm/model-provider.ts';
import { createStrategyAnalystAgent } from '../../mastra/agents/strategy-analyst.agent.ts';

describe('MastraStrategyAnalyst (construction)', () => {
  it('stores the label and builds an agent from an injected model', () => {
    const { model, label } = resolveLanguageModel({ MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'dummy' }, 'anthropic/claude-sonnet-4-6');
    const a = new MastraStrategyAnalyst(createStrategyAnalystAgent(model), label);
    expect(a.adapter).toBe('mastra');
    expect(a.model).toBe('anthropic/claude-sonnet-4-6');
  });
});

const env = loadEnv();
const live = env.RUN_LLM_TESTS && env.ANTHROPIC_API_KEY ? describe : describe.skip;

live('MastraStrategyAnalyst (live LLM)', () => {
  it('returns a schema-valid profile for a sample source', async () => {
    const { model, label } = resolveLanguageModel(env, env.STRATEGY_ANALYST_MODEL);
    const a = new MastraStrategyAnalyst(createStrategyAnalystAgent(model), label);
    const out = await a.analyze({
      kind: 'manual_description',
      content: 'Go long when open interest rises while price drops into a liquidation cluster; exit on funding flip.',
    });
    expect(AnalystProfileOutputSchema.safeParse(out).success).toBe(true);
  }, 60_000);
});
