import { describe, it, expect } from 'vitest';
import { computeParamsHash } from './backtest-support.ts';

describe('computeParamsHash', () => {
  const params = { bars: 2, threshold: 0.5 };
  const platformRun = { datasetId: 'ds', symbols: ['ETH', 'BTC'], timeframe: '1h', period: { from: 'a', to: 'b' }, seed: 9 };
  const baselineRef = { id: 'strategy:p1', version: 'v1' };

  it('hash is symbol-order-insensitive', () => {
    const a = computeParamsHash(params, { platformRun, baselineRef });
    const b = computeParamsHash(params, { platformRun: { ...platformRun, symbols: ['BTC', 'ETH'] }, baselineRef });
    expect(a).toBe(b);
  });

  it('hash changes when the dataset/seed/baseline changes', () => {
    const base = computeParamsHash(params, { platformRun, baselineRef });
    expect(computeParamsHash(params, { platformRun: { ...platformRun, seed: 10 }, baselineRef })).not.toBe(base);
    expect(computeParamsHash(params, { platformRun, baselineRef: { id: 'strategy:p2', version: 'v1' } })).not.toBe(base);
  });

  it('hash changes when params change', () => {
    const base = computeParamsHash(params, { platformRun, baselineRef });
    expect(computeParamsHash({ bars: 3 }, { platformRun, baselineRef })).not.toBe(base);
  });
});
