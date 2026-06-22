import { describe, it, expect } from 'vitest';
import { rankAggregates, recommendEnv } from './aggregate.ts';
import type { ModelAggregate } from './types.ts';

const agg = (modelId: string, meanScore: number, passRate = 1, lat = 100): ModelAggregate =>
  ({ modelId, provider: 'p', runs: 1, meanScore, passRate, meanLatencyMs: lat });

describe('rankAggregates', () => {
  it('ranks by meanScore, then passRate, then latency', () => {
    const ranked = rankAggregates([agg('a', 0.7), agg('b', 0.9), agg('c', 0.9, 1, 50)], false);
    expect(ranked.map((r) => r.modelId)).toEqual(['c', 'b', 'a']);
  });
});

describe('recommendEnv', () => {
  it('recommends own-env when best beats incumbent by >= margin and PASSes', () => {
    const ranked = rankAggregates([agg('nano', 0.78), agg('strong', 0.90)], false);
    const rec = recommendEnv(ranked, { incumbentModelId: 'nano', threshold: 0.75, margin: 0.05 });
    expect(rec.decision).toBe('own-env');
    expect(rec.recommendedModelId).toBe('strong');
    expect(rec.delta).toBeCloseTo(0.12, 5);
  });
  it('keeps sharing when the margin is not met', () => {
    const ranked = rankAggregates([agg('nano', 0.86), agg('strong', 0.88)], false);
    const rec = recommendEnv(ranked, { incumbentModelId: 'nano', threshold: 0.75, margin: 0.05 });
    expect(rec.decision).toBe('keep-sharing');
  });
  it('keeps sharing when the best does not clear the threshold', () => {
    const ranked = rankAggregates([agg('nano', 0.40, 0), agg('strong', 0.60, 0)], false);
    const rec = recommendEnv(ranked, { incumbentModelId: 'nano', threshold: 0.75, margin: 0.05 });
    expect(rec.decision).toBe('keep-sharing');
  });
});
