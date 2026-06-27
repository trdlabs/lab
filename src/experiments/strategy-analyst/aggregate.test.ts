// src/experiments/strategy-analyst/aggregate.test.ts
import { describe, it, expect } from 'vitest';
import { mean, median, std, quantile, aggregateRuns, rankAggregates } from './aggregate.ts';
import type { CandidateResult, ModelAggregate, ScoreResult, JudgeVerdict } from './types.ts';

describe('mean / median / std / quantile', () => {
  it('mean', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([5])).toBe(5);
  });
  it('median (odd)', () => expect(median([3, 1, 2])).toBe(2));
  it('median (even = avg of two central)', () => expect(median([1, 2, 3, 4])).toBe(2.5));
  it('std is population (divide by n) and n=1 -> 0', () => {
    expect(std([5])).toBe(0);
    expect(std([2, 4])).toBe(1); // mean 3, deviations 1 & 1 -> sqrt(1)
    expect(std([1, 2, 3, 4, 5])).toBeCloseTo(Math.sqrt(2), 10);
  });
  it('quantile (linear interpolation)', () => {
    expect(quantile([10], 0.9)).toBe(10);
    expect(quantile([0, 10], 0.5)).toBe(5);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5); // == median
    expect(quantile([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4, 5], 1)).toBe(5);
  });
});

function score(s: number): ScoreResult {
  return { gates: { schemaValid: true, directionLong: true }, checks: [], score: s, threshold: 0.8, verdict: s >= 0.8 ? 'PASS' : 'FAIL' };
}
function run(over: Partial<CandidateResult> & { model: string }): CandidateResult {
  return {
    provider: 'p', modelId: 'm', latencyMs: 100, verdict: 'PASS',
    score: score(0.9), secondaryScore: null, rawOutput: null, error: null, judge: null, ...over,
  };
}

describe('aggregateRuns', () => {
  it('aggregates det/passRate/runs/latency over mixed runs; det only over ok runs', () => {
    const runs: CandidateResult[] = [
      run({ model: 'a', verdict: 'PASS', score: score(0.9), latencyMs: 100 }),
      run({ model: 'a', verdict: 'FAIL', score: score(0.7), latencyMs: 200 }),
      run({ model: 'a', verdict: 'FAIL', score: null, error: { type: 'schema', message: 'x' }, latencyMs: 60 }),
    ];
    const a = aggregateRuns(runs);
    expect(a.runs).toEqual({ total: 3, ok: 2, failed: 1, failedByType: { schema: 1 } });
    expect(a.passRate).toBeCloseTo(1 / 3, 10); // 1 PASS / 3 total (failed counts as non-PASS)
    expect(a.det!.mean).toBeCloseTo(0.8, 10);  // (0.9 + 0.7) / 2 — failed run excluded
    expect(a.det!.min).toBe(0.7);
    expect(a.det!.max).toBe(0.9);
    expect(a.latency.mean).toBeCloseTo((100 + 200 + 60) / 3, 10); // over ALL runs
    expect(a.judge).toBeNull();
  });

  it('judge stats computed only over runs that produced a judge verdict', () => {
    const j = (s: number): JudgeVerdict => ({ dimensions: [], overallScore: s, hallucinations: [], missingFromProfile: [], notes: '' });
    const a = aggregateRuns([run({ model: 'a', judge: j(0.8) }), run({ model: 'a', judge: j(0.9) })]);
    expect(a.judge!.mean).toBeCloseTo(0.85, 10);
    expect(a.judge!.std).toBeCloseTo(0.05, 10);
  });
});

describe('rankAggregates', () => {
  const mk = (model: string, judgeMean: number | null, passRate: number, detMean: number): ModelAggregate => ({
    model, provider: 'p', modelId: model, runs: { total: 1, ok: 1, failed: 0, failedByType: {} }, passRate,
    det: { mean: detMean, median: detMean, std: 0, min: detMean, max: detMean },
    judge: judgeMean == null ? null : { mean: judgeMean, median: judgeMean, std: 0, min: judgeMean, max: judgeMean },
    latency: { mean: 1, median: 1 },
  });
  it('judge enabled: judge-mean desc, then passRate, then det', () => {
    const r = rankAggregates([mk('a', 0.8, 1, 0.9), mk('b', 0.95, 0.5, 0.7), mk('c', 0.9, 1, 0.95)], true);
    expect(r.map((x) => x.model)).toEqual(['b', 'c', 'a']);
  });
  it('judge disabled: passRate desc, then det', () => {
    const r = rankAggregates([mk('a', null, 0.5, 0.9), mk('b', null, 1, 0.7), mk('c', null, 1, 0.95)], false);
    expect(r.map((x) => x.model)).toEqual(['c', 'b', 'a']);
  });
});
