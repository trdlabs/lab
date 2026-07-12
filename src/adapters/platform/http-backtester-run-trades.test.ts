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

function fakeClientReturningRows(rows: unknown[], artifactType = 'trades', artifactContractVersion = '022.1') {
  return {
    getArtifactManifest: async () => ({
      artifactContractVersion,
      descriptors: [
        { artifactType, contentHash: 'h1', availability: 'available', approxItemCount: rows.length },
      ],
    }),
    readArtifact: async () => ({ page: rows, total: rows.length, offset: 0 }),
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

  it('[P1-11] rejects a trades row with an unrecognized side instead of coercing to long', async () => {
    const client = {
      getArtifactManifest: async () => ({ descriptors: [{ artifactType: 'trades', contentHash: 'h1', availability: 'available', approxItemCount: 1 }] }),
      readArtifact: async () => ({ page: [{ entryTs: 1, exitTs: 2, side: 'buy', realizedPnl: 3 }], total: 1, offset: 0 }),
    } as never;
    await expect(new HttpBacktesterRunTradesAdapter(client).getRunTrades('r')).rejects.toThrow(/side/);
  });

  it('[P1-11] rejects a trades row with a non-numeric realizedPnl instead of coercing to 0', async () => {
    const client = {
      getArtifactManifest: async () => ({ descriptors: [{ artifactType: 'trades', contentHash: 'h1', availability: 'available', approxItemCount: 1 }] }),
      readArtifact: async () => ({ page: [{ entryTs: 1, exitTs: 2, side: 'long', realizedPnl: 'oops' }], total: 1, offset: 0 }),
    } as never;
    await expect(new HttpBacktesterRunTradesAdapter(client).getRunTrades('r')).rejects.toThrow(/realizedPnl/);
  });

  it('[P1-11] rejects a NaN realizedPnl (would poison the preservation veto sums)', async () => {
    const client = {
      getArtifactManifest: async () => ({ descriptors: [{ artifactType: 'trades', contentHash: 'h1', availability: 'available', approxItemCount: 1 }] }),
      readArtifact: async () => ({ page: [{ entryTs: 1, exitTs: 2, side: 'short', realizedPnl: NaN }], total: 1, offset: 0 }),
    } as never;
    await expect(new HttpBacktesterRunTradesAdapter(client).getRunTrades('r')).rejects.toThrow(/realizedPnl/);
  });

  it('parseTrade keeps closeReason from the artifact row', async () => {
    const client = {
      getArtifactManifest: async () => ({ descriptors: [{ artifactType: 'trades', contentHash: 'h1', availability: 'available', approxItemCount: 1 }] }),
      readArtifact: async () => ({ page: [{ entryTs: 1000, exitTs: 2000, side: 'long', realizedPnl: 5, closeReason: 'end_of_data' }], total: 1, offset: 0 }),
    } as never;
    const trades = await new HttpBacktesterRunTradesAdapter(client).getRunTrades('run1');
    expect(trades[0]!.closeReason).toBe('end_of_data');
  });

  it('getBaselineRunTrades reads the baseline-trades descriptor (with closeReason)', async () => {
    const client = fakeClientReturningRows(
      [{ entryTs: 1, exitTs: 2, side: 'long', realizedPnl: -5, closeReason: 'end_of_data' }],
      'baseline-trades', // artifactType the fake manifest should expose
    );
    const trades = await new HttpBacktesterRunTradesAdapter(client).getBaselineRunTrades('cmp-run');
    expect(trades).not.toBeNull();
    expect(trades![0]!.closeReason).toBe('end_of_data');
  });

  it('getBaselineRunTrades returns null when no baseline-trades descriptor exists (old backtester)', async () => {
    const client = fakeClientReturningRows([], 'trades'); // only a 'trades' descriptor, no baseline-trades
    const trades = await new HttpBacktesterRunTradesAdapter(client).getBaselineRunTrades('cmp-run');
    expect(trades).toBeNull();
  });

  it('reads a baseline-trades artifact from a manifest tagged artifactContractVersion 022.2 (rollout tolerance)', async () => {
    const client = fakeClientReturningRows(
      [{ entryTs: 1, exitTs: 2, side: 'long', realizedPnl: -5, closeReason: 'end_of_data' }],
      'baseline-trades',
      '022.2', // artifactContractVersion on the manifest
    );
    const trades = await new HttpBacktesterRunTradesAdapter(client).getBaselineRunTrades('cmp-run');
    expect(trades).not.toBeNull();
    expect(trades!).toHaveLength(1);
  });
});
