import { describe, it, expect } from 'vitest';
import { FakeRunTradesAdapter } from './fake-run-trades.adapter.ts';

describe('FakeRunTradesAdapter.getBaselineRunTrades', () => {
  it('returns seeded baseline trades from the separate baselineByRun map', async () => {
    const a = new FakeRunTradesAdapter(
      { 'cmp-run': [{ entryTs: 1, exitTs: 2, side: 'long', realizedPnl: 3 }] },
      { 'cmp-run': [{ entryTs: 1, exitTs: 2, side: 'long', realizedPnl: -9 }] },
    );
    expect(await a.getBaselineRunTrades('cmp-run')).toEqual([{ entryTs: 1, exitTs: 2, side: 'long', realizedPnl: -9 }]);
  });
  it('returns null (not []) for an unknown run', async () => {
    expect(await new FakeRunTradesAdapter().getBaselineRunTrades('nope')).toBeNull();
  });
});
