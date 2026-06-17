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
  it('returns canned operational events as a page envelope', async () => {
    const page = await a.getOperationalEvents('r1');
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items[0]?.runId).toBeTruthy();
    expect(page.nextCursor).toBeNull();
    expect(typeof page.asOf).toBe('number');
  });
  it('returns canned decision log entries as a page envelope', async () => {
    const page = await a.getDecisionLog('r1');
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items[0]?.runId).toBeTruthy();
    expect(page.nextCursor).toBeNull();
    expect(typeof page.asOf).toBe('number');
  });
});
