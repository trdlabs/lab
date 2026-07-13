import { describe, it, expect } from 'vitest';
import { PlatformRunConfigSchema } from './platform-run-config.schema.ts';

describe('PlatformRunConfigSchema', () => {
  const valid = {
    datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h',
    period: { from: '2026-01-01', to: '2026-03-01' }, seed: 7,
  };

  it('parses a well-formed config', () => {
    const r = PlatformRunConfigSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual(valid);
  });

  it('rejects a missing period', () => {
    const { period, ...noPeriod } = valid;
    expect(PlatformRunConfigSchema.safeParse(noPeriod).success).toBe(false);
  });

  it('rejects an empty datasetId', () => {
    expect(PlatformRunConfigSchema.safeParse({ ...valid, datasetId: '' }).success).toBe(false);
  });

  it('rejects a non-integer seed', () => {
    expect(PlatformRunConfigSchema.safeParse({ ...valid, seed: 1.5 }).success).toBe(false);
  });

  it('rejects an empty symbols array (preserves the HypothesisBuildPayloadSchema invariant)', () => {
    expect(PlatformRunConfigSchema.safeParse({ ...valid, symbols: [] }).success).toBe(false);
  });
});
