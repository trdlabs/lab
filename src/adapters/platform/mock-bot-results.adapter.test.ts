import { describe, it, expect } from 'vitest';
import { MockBotResultsAdapter } from './mock-bot-results.adapter.ts';

describe('MockBotResultsAdapter', () => {
  const a = new MockBotResultsAdapter();
  it('returns at least one canned run with a valid shape', async () => {
    const runs = await a.listBotRuns();
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]?.runId).toBeTruthy();
    expect(['live', 'paper', 'backtest']).toContain(runs[0]?.mode);
  });
  it('returns canned trades and a summary for a run', async () => {
    expect((await a.getClosedTrades('r1')).length).toBeGreaterThan(0);
    const s = await a.getRunSummary('r1');
    expect(s.runId).toBeTruthy();
    expect(typeof s.pnlUsd).toBe('string'); // decimal-as-string
  });
});
