// src/experiments/strategy-analyst/eval-harness.test.ts
import { describe, it, expect } from 'vitest';
import { runEval } from './eval-harness.ts';
import type { StrategyAnalystPort } from '../../ports/strategy-analyst.port.ts';
import type { StrategyAnalystInput } from '../../domain/strategy-source.ts';
import type { AnalystProfileOutput } from '../../domain/strategy-profile.ts';
import type { JudgeVerdict } from './types.ts';
import { GOOD_LONG_OI_PROFILE } from './__fixtures__/profiles.ts';

function fakeAnalyst(out: AnalystProfileOutput): StrategyAnalystPort {
  return {
    adapter: 'fake',
    model: 'fake',
    async analyze(_input: StrategyAnalystInput): Promise<AnalystProfileOutput> {
      return out;
    },
  };
}

function throwingAnalyst(message: string): StrategyAnalystPort {
  return {
    adapter: 'fake',
    model: 'fake',
    async analyze(): Promise<AnalystProfileOutput> {
      throw new Error(message);
    },
  };
}

const baseInput = {
  models: ['anthropic/claude-x', 'openai/gpt-x'],
  fixtureId: 'long-oi',
  fixtureText: 'long only strategy text',
  fixtureFingerprint: 'sha256:abc',
  threshold: 0.8,
};

function deps(map: Record<string, StrategyAnalystPort>, judge?: (p: AnalystProfileOutput) => Promise<JudgeVerdict>) {
  let tick = 0;
  return {
    analystFor: (m: string) => map[m]!,
    providerOf: (m: string) => ({ provider: m.split('/')[0]!, modelId: m.split('/').slice(1).join('/') }),
    clock: () => (tick += 100), // deterministic latency
    judge,
  };
}

describe('runEval', () => {
  it('passes the fixture as manual_description content and scores each model', async () => {
    let seen: StrategyAnalystInput | undefined;
    const capturing: StrategyAnalystPort = {
      adapter: 'fake', model: 'fake',
      async analyze(input) { seen = input; return GOOD_LONG_OI_PROFILE; },
    };
    const result = await runEval(baseInput, deps({ 'anthropic/claude-x': capturing, 'openai/gpt-x': capturing }));
    expect(seen).toEqual({ kind: 'manual_description', content: 'long only strategy text', title: 'long-oi' });
    expect(result.perModel).toHaveLength(2);
    expect(result.perModel.every((r) => r.verdict === 'PASS')).toBe(true);
    expect(result.overallSuccess).toBe(true);
    expect(result.fixture).toEqual({ id: 'long-oi', fingerprint: 'sha256:abc' });
  });

  it('isolates a throwing model: FAIL + error recorded, run continues, other model PASSes', async () => {
    const result = await runEval(baseInput, deps({
      'anthropic/claude-x': throwingAnalyst('schema validation failed'),
      'openai/gpt-x': fakeAnalyst(GOOD_LONG_OI_PROFILE),
    }));
    expect(result.perModel).toHaveLength(2);
    const bad = result.perModel.find((r) => r.model === 'anthropic/claude-x')!;
    expect(bad.verdict).toBe('FAIL');
    expect(bad.score).toBeNull();
    expect(bad.rawOutput).toBeNull();
    expect(bad.error).toEqual({ type: 'schema', message: 'schema validation failed' });
    const good = result.perModel.find((r) => r.model === 'openai/gpt-x')!;
    expect(good.verdict).toBe('PASS');
    expect(result.overallSuccess).toBe(true);
  });

  it('classifies a timeout error', async () => {
    const result = await runEval({ ...baseInput, models: ['x/y'] }, deps({ 'x/y': throwingAnalyst('request timed out after 30s') }));
    expect(result.perModel[0]!.error!.type).toBe('timeout');
  });

  it('runs an injected judge and attaches its verdict (separate from deterministic verdict)', async () => {
    const judgeVerdict: JudgeVerdict = { dimensions: [], overallScore: 0.9, hallucinations: [], missingFromProfile: [], notes: 'ok' };
    const result = await runEval({ ...baseInput, models: ['x/y'] },
      deps({ 'x/y': fakeAnalyst(GOOD_LONG_OI_PROFILE) }, async () => judgeVerdict));
    expect(result.judgeEnabled).toBe(true);
    expect(result.perModel[0]!.judge).toEqual(judgeVerdict);
    expect(result.perModel[0]!.verdict).toBe('PASS'); // judge did not change it
  });

  it('judge failure does not fail the candidate (judge stays null)', async () => {
    const result = await runEval({ ...baseInput, models: ['x/y'] },
      deps({ 'x/y': fakeAnalyst(GOOD_LONG_OI_PROFILE) }, async () => { throw new Error('judge boom'); }));
    expect(result.perModel[0]!.verdict).toBe('PASS');
    expect(result.perModel[0]!.judge).toBeNull();
  });
});
