import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FixtureBotResultsAdapter } from './fixture-bot-results.adapter.ts';

const DIR = fileURLToPath(new URL('./__fixtures__/bot-results', import.meta.url));

describe('FixtureBotResultsAdapter', () => {
  const a = new FixtureBotResultsAdapter(DIR);
  it('reads runs/trades/summary fixtures into SDK shapes', async () => {
    const runs = await a.listBotRuns();
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]?.runId).toBeTruthy();
    const trades = await a.getClosedTrades(runs[0]!.runId);
    expect(trades.length).toBeGreaterThan(0);
    const s = await a.getRunSummary(runs[0]!.runId);
    expect(typeof s.pnlUsd).toBe('string');
  });

  it('reads operational events pages and propagates cursor selection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fixture-bot-results-events-'));
    writeFileSync(join(dir, 'runs.json'), '[]');
    writeFileSync(join(dir, 'trades.json'), '[]');
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({
      runId: 'fx_run_001', excludesReconcile: true, asOf: 1700000600000,
      closedTrades: 0, wins: 0, losses: 0, breakeven: 0, winratePct: 0, pnlUsd: '0', avgPnl: '0', exitReasons: {},
    }));
    writeFileSync(join(dir, 'events-fx_run_001.json'), JSON.stringify({
      items: [{ category: 'risk', severity: 'warn', runId: 'fx_run_001', tradeId: null, tsMs: 1700000100000, safeMessage: 'initial page' }],
      nextCursor: 'c1', asOf: 1700000600000, window: {}, freshness: 'fresh',
    }));
    writeFileSync(join(dir, 'events-fx_run_001@c1.json'), JSON.stringify({
      items: [{ category: 'risk', severity: 'info', runId: 'fx_run_001', tradeId: null, tsMs: 1700000200000, safeMessage: 'cursor page' }],
      nextCursor: null, asOf: 1700000600000, window: {}, freshness: 'fresh',
    }));

    const page1 = await new FixtureBotResultsAdapter(dir).getOperationalEvents('fx_run_001');
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBe('c1');

    const page2 = await new FixtureBotResultsAdapter(dir).getOperationalEvents('fx_run_001', 'c1');
    expect(page2.items[0]?.safeMessage).toBe('cursor page');
    expect(page2.nextCursor).toBeNull();
  });

  it('reads decision log pages and preserves asOf', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fixture-bot-results-decisions-'));
    writeFileSync(join(dir, 'runs.json'), '[]');
    writeFileSync(join(dir, 'trades.json'), '[]');
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({
      runId: 'fx_run_001', excludesReconcile: true, asOf: 1700000600000,
      closedTrades: 0, wins: 0, losses: 0, breakeven: 0, winratePct: 0, pnlUsd: '0', avgPnl: '0', exitReasons: {},
    }));
    writeFileSync(join(dir, 'decisions-fx_run_001.json'), JSON.stringify({
      items: [{ category: 'entry', runId: 'fx_run_001', botId: 'bot-1', symbol: 'BTCUSDT', side: 'long', reason: 'breakout', tsMs: 1700000100000, safeMessage: 'opened' }],
      nextCursor: null, asOf: 1700000600000, window: {}, freshness: 'fresh',
    }));

    const page = await new FixtureBotResultsAdapter(dir).getDecisionLog('fx_run_001');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.botId).toBe('bot-1');
    expect(page.asOf).toBe(1700000600000);
  });
});
