import { describe, expect, it } from 'vitest';
import type { BotRunResultDetail } from '../../ports/bot-results-read.port.ts';
import { buildBotResultsDigestText } from './bot-results-digest.ts';

const detail: BotRunResultDetail = {
  run: {
    runId: 'run_1',
    mode: 'paper',
    status: 'finished',
    bundleId: null, strategy: { name: 'long-oi', version: '1.0.0' },
    startedAtMs: Date.UTC(2026, 5, 1),
    finishedAtMs: Date.UTC(2026, 5, 2),
    lastSeenMs: Date.UTC(2026, 5, 2),
    symbols: ['BTCUSDT'],
  },
  summary: {
    runId: 'run_1',
    excludesReconcile: true,
    asOf: Date.UTC(2026, 5, 2),
    closedTrades: 3,
    wins: 1,
    losses: 2,
    breakeven: 0,
    winratePct: 33.33,
    pnlUsd: '-11.00000000',
    avgPnl: '-3.66666667',
    exitReasons: { stop_loss: 2, take_profit: 1 },
  },
  trades: [
    {
      tradeId: 'win',
      runId: 'run_1',
      symbol: 'BTCUSDT',
      side: 'long',
      openedAtMs: Date.UTC(2026, 5, 1, 0, 0),
      closedAtMs: Date.UTC(2026, 5, 1, 1, 0),
      realizedPnl: '9',
      pnlPct: '0.9',
      isWin: true,
      closeReason: 'take_profit_final',
      entryPrice: null, exitPrice: null, closeReasonRaw: null,
    },
    {
      tradeId: 'loss_fast',
      runId: 'run_1',
      symbol: 'BTCUSDT',
      side: 'long',
      openedAtMs: Date.UTC(2026, 5, 1, 2, 0),
      closedAtMs: Date.UTC(2026, 5, 1, 2, 30),
      realizedPnl: '-5',
      pnlPct: '-0.5',
      isWin: false,
      closeReason: 'stop_loss',
      entryPrice: null, exitPrice: null, closeReasonRaw: null,
    },
    {
      tradeId: 'loss_slow',
      runId: 'run_1',
      symbol: 'ETHUSDT',
      side: 'long',
      openedAtMs: Date.UTC(2026, 5, 1, 3, 0),
      closedAtMs: Date.UTC(2026, 5, 1, 6, 0),
      realizedPnl: '-15',
      pnlPct: '-1.5',
      isWin: false,
      closeReason: 'stop_loss',
      entryPrice: null, exitPrice: null, closeReasonRaw: null,
    },
  ],
};

describe('buildBotResultsDigestText', () => {
  it('summarizes aggregate run metrics and worst losing trades', () => {
    const text = buildBotResultsDigestText([detail], { worstTradesLimit: 2 });

    expect(text).toContain('Live/paper bot performance evidence');
    expect(text).toContain('long-oi@1.0.0 [paper/finished]');
    expect(text).toContain('trades=3 winratePct=33.33 pnlUsd=-11.00000000 avgPnl=-3.66666667');
    expect(text).toContain('avgHoldingMinutes=90');
    expect(text).toContain('exitReasons=stop_loss:2, take_profit:1');
    expect(text).toContain('Worst losing trades:');
    expect(text).toContain('ETHUSDT pnlUsd=-15 pnlPct=-1.5 holdingMinutes=180 closeReason=stop_loss');
    expect(text).toContain('BTCUSDT pnlUsd=-5 pnlPct=-0.5 holdingMinutes=30 closeReason=stop_loss');
  });

  it('returns null for empty input', () => {
    expect(buildBotResultsDigestText([])).toBeNull();
  });
});
