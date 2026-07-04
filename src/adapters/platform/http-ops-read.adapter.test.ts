import { describe, it, expect } from 'vitest';
import { OpsReadClient, type FetchLike } from './ops-read-client.ts';
import { HttpOpsReadAdapter } from './http-ops-read.adapter.ts';
import type {
  BotRunRecord,
  ClosedTrade,
  RunSummary,
  DecisionLogEntry,
  OperationalEvent,
} from '../../ports/bot-results-read.port.ts';

const RUN_A: BotRunRecord = { runId: 'r1', mode: 'paper', status: 'finished', bundleId: null, strategy: { name: 's', version: '1' }, startedAtMs: 1, finishedAtMs: 2, lastSeenMs: 2, symbols: ['BTC'] };
const RUN_B: BotRunRecord = { ...RUN_A, runId: 'r2' };
const TRADE: ClosedTrade = { tradeId: 't1', runId: 'r1', symbol: 'BTC', side: 'long', openedAtMs: 1, closedAtMs: 2, realizedPnl: '1.5', pnlPct: '0.1', isWin: true, closeReason: 'take_profit_final', entryPrice: null, exitPrice: null, closeReasonRaw: null };
const SUMMARY: RunSummary = { runId: 'r1', excludesReconcile: true, asOf: 9, closedTrades: 1, wins: 1, losses: 0, breakeven: 0, winratePct: 100, pnlUsd: '1.5', avgPnl: '1.5', exitReasons: { tp: 1 } };
const EVENT: OperationalEvent = { category: 'risk', severity: 'warn', runId: 'r1', tradeId: null, tsMs: 3, safeMessage: 'warning' };
const DECISION: DecisionLogEntry = { category: 'entry', runId: 'r1', botId: 'bot-1', symbol: 'BTC', side: 'long', reason: 'breakout', tsMs: 4, safeMessage: 'entered' };

/** Normalize a path-or-URL to "pathname[?sorted=query]" so route matching is order-independent
 *  and exact — no fragile endsWith / first-match-wins (URLSearchParams does not guarantee key order). */
function norm(pathOrUrl: string): string {
  const u = new URL(pathOrUrl, 'http://x');
  const entries = [...u.searchParams.entries()]
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const qs = entries.map(([k, v]) => `${k}=${v}`).join('&');
  return u.pathname + (qs ? `?${qs}` : '');
}

/** A fake fetch that maps a NORMALIZED route key → enveloped/bare JSON; records the URLs it saw.
 *  Exact match on the normalized form: order-independent and unambiguous as routes grow. */
function routed(routes: Record<string, unknown>): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const table = new Map(Object.entries(routes).map(([k, v]) => [norm(k), v] as const));
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    const body = table.get(norm(url));
    if (body === undefined) return { ok: false, status: 404, json: async () => ({ code: 'no_route', message: url }), text: async () => '' };
    return { ok: true, status: 200, json: async () => body, text: async () => '' };
  };
  return { fetchImpl, urls };
}

function adapter(fetchImpl: FetchLike): HttpOpsReadAdapter {
  return new HttpOpsReadAdapter(new OpsReadClient({ baseUrl: 'http://h:8839', token: 't', fetchImpl }));
}

describe('HttpOpsReadAdapter', () => {
  it('listBotRuns walks cursor pages into a flat array', async () => {
    const { fetchImpl, urls } = routed({
      '/ops/runs': { items: [RUN_A], nextCursor: 'c1' },
      '/ops/runs?cursor=c1': { items: [RUN_B], nextCursor: null },
    });
    const runs = await adapter(fetchImpl).listBotRuns();
    expect(runs.map((r) => r.runId)).toEqual(['r1', 'r2']);
    expect(urls.some((u) => u.includes('cursor=c1'))).toBe(true);
  });

  it('listBotRuns passes mode/status filters as query params', async () => {
    const { fetchImpl, urls } = routed({ '/ops/runs?mode=paper&status=finished': { items: [RUN_A], nextCursor: null } });
    const runs = await adapter(fetchImpl).listBotRuns({ mode: 'paper', status: 'finished' });
    expect(runs).toHaveLength(1);
    expect(urls[0]).toContain('mode=paper');
    expect(urls[0]).toContain('status=finished');
  });

  it('getClosedTrades hits /ops/trades?runId=… and walks pages', async () => {
    const { fetchImpl, urls } = routed({
      '/ops/trades?runId=r1': { items: [TRADE], nextCursor: 'c1' },
      '/ops/trades?runId=r1&cursor=c1': { items: [{ ...TRADE, tradeId: 't2' }], nextCursor: null },
    });
    const trades = await adapter(fetchImpl).getClosedTrades('r1');
    expect(trades.map((t) => t.tradeId)).toEqual(['t1', 't2']);
    expect(urls[0]).toContain('/ops/trades?runId=r1');
  });

  it('getRunSummary hits /ops/runs/:id/summary and returns the bare object', async () => {
    const { fetchImpl } = routed({ '/ops/runs/r1/summary': SUMMARY });
    const summary = await adapter(fetchImpl).getRunSummary('r1');
    expect(summary.runId).toBe('r1');
    expect(summary.closedTrades).toBe(1);
  });

  it('getOperationalEvents returns the page envelope without flattening and passes cursor', async () => {
    const { fetchImpl, urls } = routed({
      '/ops/events?runId=r1&cursor=c1': { items: [EVENT], nextCursor: null, asOf: 9, window: {}, freshness: 'fresh' },
    });
    const page = await adapter(fetchImpl).getOperationalEvents('r1', 'c1');
    expect(page.items[0]?.category).toBe('risk');
    expect(page.asOf).toBe(9);
    expect(urls[0]).toContain('/ops/events');
    expect(urls[0]).toContain('cursor=c1');
  });

  it('getDecisionLog returns the page envelope without flattening', async () => {
    const { fetchImpl, urls } = routed({
      '/ops/decisions?runId=r1': { items: [DECISION], nextCursor: 'n1', asOf: 9, window: {}, freshness: 'fresh' },
    });
    const page = await adapter(fetchImpl).getDecisionLog('r1');
    expect(page.items[0]?.botId).toBe('bot-1');
    expect(page.nextCursor).toBe('n1');
    expect(urls[0]).toContain('/ops/decisions?runId=r1');
  });
});
