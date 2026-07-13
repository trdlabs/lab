import { describe, it, expect } from 'vitest';
import { resolveEvalPeriod } from './eval-period-resolver.ts';
import type { DatasetDescriptor } from '../ports/research-run-lifecycle.ts';
import type { PlatformRunConfig } from '../ports/research-platform.port.ts';

const fallback: PlatformRunConfig = {
  datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h',
  period: { from: '2020-01-01', to: '2020-02-01' }, seed: 7,
};

function dataset(over: Partial<DatasetDescriptor> = {}): DatasetDescriptor {
  return {
    datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h',
    dateRange: { from: '2026-01-01', to: '2026-03-01' }, coveredKinds: [], ...over,
  };
}

describe('resolveEvalPeriod', () => {
  it('binds the period to the matching dataset dateRange', () => {
    const r = resolveEvalPeriod([dataset()], fallback);
    expect(r.source).toBe('dataset');
    expect(r.runConfig.period).toEqual({ from: '2026-01-01', to: '2026-03-01' });
    // everything else stays from fallback
    expect(r.runConfig.datasetId).toBe('ds');
    expect(r.runConfig.seed).toBe(7);
  });

  it('falls back on an empty dataset list', () => {
    const r = resolveEvalPeriod([], fallback);
    expect(r).toEqual({ runConfig: fallback, source: 'fallback', fallbackReason: 'no_datasets' });
  });

  it('falls back when no dataset id matches', () => {
    const r = resolveEvalPeriod([dataset({ datasetId: 'other' })], fallback);
    expect(r.source).toBe('fallback');
    expect(r.fallbackReason).toBe('dataset_not_found');
  });

  it('falls back when the timeframe does not match', () => {
    const r = resolveEvalPeriod([dataset({ timeframe: '1m' })], fallback);
    expect(r.fallbackReason).toBe('dataset_not_found');
  });

  it('falls back on an unparseable dateRange', () => {
    const r = resolveEvalPeriod([dataset({ dateRange: { from: 'not-a-date', to: '2026-03-01' } })], fallback);
    expect(r.fallbackReason).toBe('invalid_range');
  });

  it('falls back when from >= to', () => {
    const r = resolveEvalPeriod([dataset({ dateRange: { from: '2026-03-01', to: '2026-01-01' } })], fallback);
    expect(r.fallbackReason).toBe('invalid_range');
  });

  it('falls back on an empty dateRange string', () => {
    const r = resolveEvalPeriod([dataset({ dateRange: { from: '', to: '' } })], fallback);
    expect(r.fallbackReason).toBe('no_date_range');
  });

  it('never throws on the matched dataset, returns fallback on bad range', () => {
    expect(() => resolveEvalPeriod([dataset({ dateRange: { from: '', to: '' } })], fallback)).not.toThrow();
  });
});
