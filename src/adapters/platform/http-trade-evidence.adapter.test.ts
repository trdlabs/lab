import { describe, it, expect } from 'vitest';
import { HttpTradeEvidenceAdapter } from './http-trade-evidence.adapter.ts';
import { OpsReadClient, type FetchLike } from './ops-read-client.ts';

function row(tradeId: string, extra: Record<string, unknown> = {}) {
  return {
    tradeId, runId: 'r1', symbol: 'ESPORTSUSDT', side: 'long',
    openedAtMs: 1_000_000, closedAtMs: 1_600_000,
    entryPrice: '0.0512', exitPrice: '0.0447', realizedPnl: '-46.78', pnlPct: '-12.64', closeReason: 'hard_stop',
    lifecycle: [
      { tsMs: 1_000_000, type: 'entry', price: '0.0512', qty: '900' },
      { tsMs: 1_300_000, type: 'dca', price: '0.0490', qty: '900' },
      { tsMs: 1_600_000, type: 'sl', price: '0.0447', qty: '1800' },
    ],
    ...extra,
  };
}

/** Capture requested URLs; return queued JSON pages. */
function fakeFetch(pages: unknown[]): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    const body = pages[Math.min(i, pages.length - 1)];
    i += 1;
    return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } };
  };
  return { fetch, urls };
}

describe('HttpTradeEvidenceAdapter', () => {
  it('maps /ops/trade-evidence rows to TradeEvidenceBundles (prices + lifecycle; minuteContext dropped)', async () => {
    const { fetch, urls } = fakeFetch([{ items: [row('t1')], nextCursor: null }]);
    const client = new OpsReadClient({ baseUrl: 'http://ops:8839', token: 'tok', fetchImpl: fetch });
    const out = await new HttpTradeEvidenceAdapter(client).getTradeEvidence({ tradeIds: ['t1'], minuteWindowBefore: 20, minuteWindowAfter: 180 });
    expect(urls[0]).toBe('http://ops:8839/ops/trade-evidence?tradeIds=t1');
    expect(out.length).toBe(1);
    const b = out[0]!;
    expect(b.tradeId).toBe('t1');
    expect(b.symbol).toBe('ESPORTSUSDT');
    expect(b.enteredAtMs).toBe(1_000_000);
    expect(b.closedAtMs).toBe(1_600_000);
    expect(b.entryPrice).toBe('0.0512');
    expect(b.exitPrice).toBe('0.0447');
    expect(b.holdingDurationMs).toBe(600_000); // closed - opened
    expect(b.lifecycleEvents.map((e) => e.type)).toEqual(['entry', 'dca', 'sl']);
    expect(b.lifecycleEvents[1]!.price).toBe('0.0490');
    expect(b.minuteContext).toEqual([]); // dropped — Slice A owns the window
  });

  it('joins multiple tradeIds and walks cursor pages', async () => {
    const { fetch, urls } = fakeFetch([
      { items: [row('t1')], nextCursor: 'c2' },
      { items: [row('t2')], nextCursor: null },
    ]);
    const client = new OpsReadClient({ baseUrl: 'http://ops:8839', token: 'tok', fetchImpl: fetch });
    const out = await new HttpTradeEvidenceAdapter(client).getTradeEvidence({ tradeIds: ['t1', 't2'], minuteWindowBefore: 0, minuteWindowAfter: 0 });
    expect(urls[0]).toBe('http://ops:8839/ops/trade-evidence?tradeIds=t1%2Ct2');
    expect(urls[1]).toBe('http://ops:8839/ops/trade-evidence?tradeIds=t1%2Ct2&cursor=c2');
    expect(out.map((b) => b.tradeId)).toEqual(['t1', 't2']);
  });

  it('returns [] without calling the client when tradeIds is empty', async () => {
    const { fetch, urls } = fakeFetch([{ items: [], nextCursor: null }]);
    const client = new OpsReadClient({ baseUrl: 'http://ops:8839', token: 'tok', fetchImpl: fetch });
    const out = await new HttpTradeEvidenceAdapter(client).getTradeEvidence({ tradeIds: [], minuteWindowBefore: 0, minuteWindowAfter: 0 });
    expect(out).toEqual([]);
    expect(urls.length).toBe(0);
  });

  it('maps a null closedAtMs to a null holdingDurationMs', async () => {
    const { fetch } = fakeFetch([{ items: [row('t1', { closedAtMs: null })], nextCursor: null }]);
    const client = new OpsReadClient({ baseUrl: 'http://ops:8839', token: 'tok', fetchImpl: fetch });
    const out = await new HttpTradeEvidenceAdapter(client).getTradeEvidence({ tradeIds: ['t1'], minuteWindowBefore: 0, minuteWindowAfter: 0 });
    expect(out[0]!.holdingDurationMs).toBeNull();
  });
});
