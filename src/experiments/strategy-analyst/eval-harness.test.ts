// src/experiments/strategy-analyst/eval-harness.test.ts
import { describe, it, expect } from 'vitest';
import { runEval } from './eval-harness.ts';
import type { StrategyAnalystPort } from '../../ports/strategy-analyst.port.ts';
import type { StrategyAnalystInput } from '../../domain/strategy-source.ts';
import type { AnalystProfileOutput } from '../../domain/strategy-profile.ts';
import type { JudgeVerdict } from './types.ts';
import { CLEAN_LONG_OI_BASE, GOOD_SHORT_PUMP_PROFILE } from './__fixtures__/profiles.ts';

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

/** Throws on the first `failTimes` calls, then returns `out`. Reuse the same instance across runs. */
function flakyAnalyst(failTimes: number, out: AnalystProfileOutput): StrategyAnalystPort {
  let n = 0;
  return {
    adapter: 'fake',
    model: 'fake',
    async analyze(): Promise<AnalystProfileOutput> {
      n += 1;
      if (n <= failTimes) throw new Error('schema validation failed');
      return out;
    },
  };
}

const baseInput = {
  models: ['anthropic/claude-x', 'openai/gpt-x'],
  fixtureId: 'long-oi',
  fixtureText: 'long only strategy text',
  fixtureFingerprint: 'sha256:abc',
  threshold: 0.8,
  direction: 'long' as const,
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
      async analyze(input) { seen = input; return CLEAN_LONG_OI_BASE; },
    };
    const result = await runEval(baseInput, deps({ 'anthropic/claude-x': capturing, 'openai/gpt-x': capturing }));
    expect(seen).toEqual({ kind: 'manual_description', content: 'long only strategy text', title: 'long-oi' });
    expect(result.perModel).toHaveLength(2);
    expect(result.perModel.every((r) => r.verdict === 'PASS')).toBe(true);
    expect(result.overallSuccess).toBe(true);
    expect(result.fixture).toEqual({ id: 'long-oi', fingerprint: 'sha256:abc' });
  });

  it('passes bot_code source kind to analyst.analyze (M4 guard)', async () => {
    let seen: StrategyAnalystInput | undefined;
    const capturing: StrategyAnalystPort = {
      adapter: 'fake', model: 'fake',
      async analyze(input) { seen = input; return CLEAN_LONG_OI_BASE; },
    };
    const result = await runEval(
      { ...baseInput, sourceKind: 'bot_code' },
      deps({ 'anthropic/claude-x': capturing, 'openai/gpt-x': capturing }),
    );
    expect(seen).toEqual({ kind: 'bot_code', content: 'long only strategy text', title: 'long-oi' });
    expect(result.perModel).toHaveLength(2);
    expect(result.perModel.every((r) => r.verdict === 'PASS')).toBe(true);
    expect(result.overallSuccess).toBe(true);
  });

  it('isolates a throwing model: FAIL + error recorded, run continues, other model PASSes', async () => {
    const result = await runEval(baseInput, deps({
      'anthropic/claude-x': throwingAnalyst('schema validation failed'),
      'openai/gpt-x': fakeAnalyst(CLEAN_LONG_OI_BASE),
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
      deps({ 'x/y': fakeAnalyst(CLEAN_LONG_OI_BASE) }, async () => judgeVerdict));
    expect(result.judgeEnabled).toBe(true);
    expect(result.perModel[0]!.judge).toEqual(judgeVerdict);
    expect(result.perModel[0]!.verdict).toBe('PASS'); // judge did not change it
  });

  it('judge failure does not fail the candidate (judge stays null)', async () => {
    const result = await runEval({ ...baseInput, models: ['x/y'] },
      deps({ 'x/y': fakeAnalyst(CLEAN_LONG_OI_BASE) }, async () => { throw new Error('judge boom'); }));
    expect(result.perModel[0]!.verdict).toBe('PASS');
    expect(result.perModel[0]!.judge).toBeNull();
  });

  it('defaults to repeat=1 (regression: single run per model, one aggregate)', async () => {
    const result = await runEval({ ...baseInput, models: ['x/y'] }, deps({ 'x/y': fakeAnalyst(CLEAN_LONG_OI_BASE) }));
    expect(result.repeat).toBe(1);
    expect(result.perModel).toHaveLength(1);
    expect(result.aggregates).toHaveLength(1);
    expect(result.aggregates[0]!.runs).toEqual({ total: 1, ok: 1, failed: 0, failedByType: {} });
  });
});

describe('runEval --repeat aggregation', () => {
  it('repeat=3 runs each model 3x; identical outputs -> std 0, passRate 1, 3 ok', async () => {
    const result = await runEval(
      { ...baseInput, models: ['x/y'], repeat: 3 },
      deps({ 'x/y': fakeAnalyst(CLEAN_LONG_OI_BASE) }),
    );
    expect(result.repeat).toBe(3);
    expect(result.perModel).toHaveLength(3); // flat list = every run
    expect(result.aggregates).toHaveLength(1);
    const a = result.aggregates[0]!;
    expect(a.runs).toEqual({ total: 3, ok: 3, failed: 0, failedByType: {} });
    expect(a.passRate).toBe(1);
    expect(a.det!.std).toBe(0); // identical scores across runs
    expect(a.det!.mean).toBe(a.det!.min);
    expect(a.det!.mean).toBe(a.det!.max);
  });

  it('counts failed runs; PASS-rate denominator is N; det stats only over ok runs', async () => {
    const result = await runEval(
      { ...baseInput, models: ['x/y'], repeat: 3 },
      deps({ 'x/y': flakyAnalyst(1, CLEAN_LONG_OI_BASE) }), // run1 throws; runs 2 & 3 pass
    );
    const a = result.aggregates[0]!;
    expect(a.runs.total).toBe(3);
    expect(a.runs.ok).toBe(2);
    expect(a.runs.failed).toBe(1);
    expect(a.runs.failedByType.schema).toBe(1);
    expect(a.passRate).toBeCloseTo(2 / 3, 10); // 2 PASS / 3 total (failed run counts as non-PASS)
    expect(a.det!.std).toBe(0); // 2 identical ok scores
    expect(result.overallSuccess).toBe(true);
  });

  it('judge disabled -> aggregate.judge is null', async () => {
    const result = await runEval(
      { ...baseInput, models: ['x/y'], repeat: 2 },
      deps({ 'x/y': fakeAnalyst(CLEAN_LONG_OI_BASE) }), // no judge in deps
    );
    expect(result.judgeEnabled).toBe(false);
    expect(result.aggregates[0]!.judge).toBeNull();
  });
});

describe('runEval — completeness primary signal + scoreProfile secondary', () => {
  it('long fixture: score is direction-aware completeness AND secondaryScore is the bespoke scoreProfile', async () => {
    const result = await runEval({ ...baseInput, models: ['x/y'] }, deps({ 'x/y': fakeAnalyst(CLEAN_LONG_OI_BASE) }));
    const r = result.perModel[0]!;
    // primary deterministic verdict comes from scoreCompleteness keyed on direction 'long'
    expect(r.score!.gates.directionMatches).toBe(true);
    expect(r.verdict).toBe('PASS');
    // bespoke long-oi diagnostic retained as a secondary field (uses the directionLong gate)
    expect(r.secondaryScore).not.toBeNull();
    expect(r.secondaryScore!.gates.directionLong).toBe(true);
  });

  it('short fixture: completeness keyed on short PASSes; secondaryScore is null (not long-oi)', async () => {
    const result = await runEval(
      { ...baseInput, models: ['x/y'], fixtureId: 'short-pump', direction: 'short' as const },
      deps({ 'x/y': fakeAnalyst(GOOD_SHORT_PUMP_PROFILE) }),
    );
    const r = result.perModel[0]!;
    expect(r.score!.gates.directionMatches).toBe(true);
    expect(r.verdict).toBe('PASS');
    expect(r.secondaryScore).toBeNull();
  });

  it('a throwing model still records secondaryScore null', async () => {
    const result = await runEval({ ...baseInput, models: ['x/y'] }, deps({ 'x/y': throwingAnalyst('boom') }));
    expect(result.perModel[0]!.secondaryScore).toBeNull();
  });
});
