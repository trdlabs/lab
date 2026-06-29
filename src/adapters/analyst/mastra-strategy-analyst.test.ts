import { describe, it, expect } from 'vitest';
import { buildPrompt, MastraStrategyAnalyst } from './mastra-strategy-analyst.ts';
import { AnalystProfileOutputSchema } from '../../domain/strategy-profile.ts';
import { loadEnv } from '../../config/env.ts';
import { resolveLanguageModel } from '../llm/model-provider.ts';
import { createStrategyAnalystAgent, INSTRUCTIONS } from '../../mastra/agents/strategy-analyst.agent.ts';

describe('MastraStrategyAnalyst (construction)', () => {
  it('stores the label and builds an agent from an injected model', () => {
    const { model, label } = resolveLanguageModel({ MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'dummy' }, 'anthropic/claude-sonnet-4-6');
    const a = new MastraStrategyAnalyst(createStrategyAnalystAgent(model), label);
    expect(a.adapter).toBe('mastra');
    expect(a.model).toBe('anthropic/claude-sonnet-4-6');
  });
});

describe('strategy-analyst INSTRUCTIONS', () => {
  it('contains the five structured extraction section markers', () => {
    expect(INSTRUCTIONS).toContain('Entry conditions');
    expect(INSTRUCTIONS).toContain('Exit &');
    expect(INSTRUCTIONS).toContain('invalidation');
    expect(INSTRUCTIONS).toContain('OHLCV');
    expect(INSTRUCTIONS).toContain('Position management');
  });

  it('retains the no-invent guardrail', () => {
    expect(INSTRUCTIONS).toContain('unknowns');
  });

  it('retains the runner-owned guardrail', () => {
    expect(INSTRUCTIONS).toContain('runnerOwnedAuthorities');
  });
});

describe('buildPrompt kind branching', () => {
  it('bot_code carries code-analysis guidance (exact/exhaustive/off-by-one)', () => {
    const p = buildPrompt({ kind: 'bot_code', content: '// ===== FILE: a.ts =====\nconst d = 10;' });
    expect(p).toContain('COMPLETE implementation');
    expect(p).toContain('EXACT');
    expect(p).toContain('off-by-one');
    expect(p).toContain('const d = 10;');
  });
  it('text kinds do NOT carry code-analysis guidance (token economy)', () => {
    const p = buildPrompt({ kind: 'manual_description', content: 'buy the rebound' });
    expect(p).not.toContain('COMPLETE implementation');
    expect(p).not.toContain('off-by-one');
    expect(p).toContain('buy the rebound');
    expect(p).toContain('Source kind: manual_description');
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
