// src/adapters/similarity/in-memory-strategy-similarity.adapter.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStrategySimilarityAdapter } from './in-memory-strategy-similarity.adapter.ts';
import type { SimilarStrategyCandidate } from '../../domain/strategy-retrieval.ts';

const makeCandidate = (
  id: string,
  overrides: Partial<SimilarStrategyCandidate> = {},
): SimilarStrategyCandidate => ({
  strategyProfileId: id,
  rrfScore: 0.1,
  metadata: {
    market: 'crypto',
    symbol: 'BTCUSDT',
    timeframe: '1h',
    direction: 'long',
    ...overrides.metadata,
  },
  ...overrides,
});

const baseQuery = () => ({
  text: 'long after dip',
  embedding: new Array(1024).fill(0.1) as number[],
  filters: {},
  lexicalLimit: 50,
  vectorLimit: 50,
  fusedLimit: 20,
});

describe('InMemoryStrategySimilarityAdapter', () => {
  let adapter: InMemoryStrategySimilarityAdapter;

  beforeEach(() => {
    adapter = new InMemoryStrategySimilarityAdapter({
      fixtures: [
        makeCandidate('p1', { metadata: { market: 'crypto', symbol: 'BTCUSDT', timeframe: '1h', direction: 'long' } }),
        makeCandidate('p2', { metadata: { market: 'crypto', symbol: 'ETHUSDT', timeframe: '1h', direction: 'long' } }),
        makeCandidate('p3', { metadata: { market: 'forex', symbol: 'EURUSD', timeframe: '4h', direction: 'short' } }),
        makeCandidate('p4', { metadata: { market: 'crypto', symbol: 'BTCUSDT', timeframe: '4h', direction: 'both' } }),
      ],
    });
  });

  it('returns all fixtures when no filters applied', async () => {
    const result = await adapter.search(baseQuery());
    expect(result.candidates.map((c) => c.strategyProfileId)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(result.degradedReasonCodes).toEqual([]);
  });

  it('filters by market', async () => {
    const result = await adapter.search({ ...baseQuery(), filters: { market: 'crypto' } });
    expect(result.candidates.map((c) => c.strategyProfileId)).toEqual(['p1', 'p2', 'p4']);
  });

  it('filters by symbol', async () => {
    const result = await adapter.search({ ...baseQuery(), filters: { symbol: 'BTCUSDT' } });
    expect(result.candidates.map((c) => c.strategyProfileId)).toEqual(['p1', 'p4']);
  });

  it('filters by timeframe', async () => {
    const result = await adapter.search({ ...baseQuery(), filters: { timeframe: '4h' } });
    expect(result.candidates.map((c) => c.strategyProfileId)).toEqual(['p3', 'p4']);
  });

  it('filters by direction', async () => {
    const result = await adapter.search({ ...baseQuery(), filters: { direction: 'short' } });
    expect(result.candidates.map((c) => c.strategyProfileId)).toEqual(['p3']);
  });

  it('combines multiple filters', async () => {
    const result = await adapter.search({
      ...baseQuery(),
      filters: { market: 'crypto', timeframe: '1h', direction: 'long' },
    });
    expect(result.candidates.map((c) => c.strategyProfileId)).toEqual(['p1', 'p2']);
  });

  it('excludes by excludeProfileId', async () => {
    const result = await adapter.search({ ...baseQuery(), excludeProfileId: 'p2' });
    expect(result.candidates.map((c) => c.strategyProfileId)).not.toContain('p2');
    expect(result.candidates).toHaveLength(3);
  });

  it('respects fusedLimit', async () => {
    const result = await adapter.search({ ...baseQuery(), fusedLimit: 2 });
    expect(result.candidates).toHaveLength(2);
  });

  it('records calls with the query and result', async () => {
    const query = baseQuery();
    await adapter.search(query);
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]!.query).toBe(query);
    expect(adapter.calls[0]!.result.candidates).toHaveLength(4);
  });

  it('rejects when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      adapter.search({ ...baseQuery(), signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('returns empty candidates when all filtered out', async () => {
    const result = await adapter.search({ ...baseQuery(), filters: { symbol: 'XYZNONEXISTENT' } });
    expect(result.candidates).toEqual([]);
    expect(result.degradedReasonCodes).toEqual([]);
  });

  it('works with no fixtures configured', async () => {
    const empty = new InMemoryStrategySimilarityAdapter();
    const result = await empty.search(baseQuery());
    expect(result.candidates).toEqual([]);
  });
});
