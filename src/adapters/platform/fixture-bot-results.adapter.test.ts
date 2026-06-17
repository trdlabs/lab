import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
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
});
