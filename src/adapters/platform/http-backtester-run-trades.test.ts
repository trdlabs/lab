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
      return { page: all.slice(offset, offset + 2), total: all.length, offset }; // fixed page size 2 → forces multi-page
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

  it('rejects a trades row missing entryTs/exitTs', async () => {
    const client = {
      getArtifactManifest: async () => ({ descriptors: [{ artifactType: 'trades', contentHash: 'h1', availability: 'available', approxItemCount: 1 }] }),
      readArtifact: async () => ({ page: [{ side: 'long', realizedPnl: 0 }], total: 1, offset: 0 }),
    } as never;
    await expect(new HttpBacktesterRunTradesAdapter(client).getRunTrades('r')).rejects.toThrow(/entryTs/);
  });

  it('parseTrade keeps closeReason from the artifact row', async () => {
    const client = {
      getArtifactManifest: async () => ({ descriptors: [{ artifactType: 'trades', contentHash: 'h1', availability: 'available', approxItemCount: 1 }] }),
      readArtifact: async () => ({ page: [{ entryTs: 1000, exitTs: 2000, side: 'long', realizedPnl: 5, closeReason: 'end_of_data' }], total: 1, offset: 0 }),
    } as never;
    const trades = await new HttpBacktesterRunTradesAdapter(client).getRunTrades('run1');
    expect(trades[0]!.closeReason).toBe('end_of_data');
  });
});
