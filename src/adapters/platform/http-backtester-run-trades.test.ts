import { describe, it, expect } from 'vitest';
import { HttpBacktesterRunTradesAdapter } from './http-backtester.adapter.ts';

function fakeClient() {
  return {
    getArtifactManifest: async () => ({
      descriptors: [
        { artifactType: 'trades', contentHash: 'h1', availability: 'available', approxItemCount: 3 },
      ],
    }),
    readArtifact: async (_r: string, _a: string, opts?: { offset?: number; limit?: number }) => {
      const all = [
        { entryTs: 1, exitTs: 2, side: 'long', realizedPnl: 5 },
        { entryTs: 3, exitTs: 4, side: 'short', realizedPnl: -1 },
        { entryTs: 5, exitTs: 6, side: 'long', realizedPnl: 2 },
      ];
      const offset = opts?.offset ?? 0;
      const limit = opts?.limit ?? 2;
      return { page: all.slice(offset, offset + limit), total: all.length, offset };
    },
  } as never;
}

describe('HttpBacktesterRunTradesAdapter', () => {
  it('pages and parses all trades', async () => {
    const a = new HttpBacktesterRunTradesAdapter(fakeClient());
    const trades = await a.getRunTrades('run1');
    expect(trades).toHaveLength(3);
    expect(trades[2]).toEqual({ entryTs: 5, exitTs: 6, side: 'long', realizedPnl: 2 });
  });

  it('returns [] when no trades descriptor', async () => {
    const client = {
      getArtifactManifest: async () => ({ descriptors: [] }),
      readArtifact: async () => ({ page: [], total: 0, offset: 0 }),
    } as never;
    expect(await new HttpBacktesterRunTradesAdapter(client).getRunTrades('r')).toEqual([]);
  });
});
