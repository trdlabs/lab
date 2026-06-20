import type {
  BotResultsReadPort,
  BotRunsFilter,
  BotRunRecord,
  ClosedTrade,
  RunSummary,
  EventsPage,
  DecisionsPage,
  OperationalEvent,
  DecisionLogEntry,
} from '../../ports/bot-results-read.port.ts';

const RUN: BotRunRecord = {
  runId: 'mock_run_001', mode: 'paper', status: 'finished',
  strategy: { name: 'mock-strategy', version: '1.0.0' },
  startedAtMs: 1_700_000_000_000, finishedAtMs: 1_700_000_600_000, lastSeenMs: 1_700_000_600_000,
  symbols: ['ESPORTSUSDT'],
};
const TRADE: ClosedTrade = {
  tradeId: 'mock_trade_001', runId: 'mock_run_001', symbol: 'ESPORTSUSDT', side: 'long',
  openedAtMs: 1_700_000_100_000, closedAtMs: 1_700_000_200_000,
  realizedPnl: '12.50', pnlPct: '1.25', isWin: true, closeReason: 'take_profit',
};
const SUMMARY: RunSummary = {
  runId: 'mock_run_001', excludesReconcile: true, asOf: 1_700_000_600_000,
  closedTrades: 1, wins: 1, losses: 0, breakeven: 0, winratePct: 100,
  pnlUsd: '12.50', avgPnl: '12.50', exitReasons: { take_profit: 1 },
};
const EVENT: OperationalEvent = {
  category: 'risk', severity: 'warn', runId: 'mock_run_001', tradeId: null,
  tsMs: 1_700_000_300_000, safeMessage: 'risk warning',
};
const DECISION: DecisionLogEntry = {
  category: 'entry', runId: 'mock_run_001', botId: 'mock-bot', symbol: 'ESPORTSUSDT',
  side: 'long', reason: 'breakout', tsMs: 1_700_000_250_000, safeMessage: 'entered long',
};
const EVENTS_PAGE: EventsPage = {
  items: [EVENT], nextCursor: null, asOf: 1_700_000_600_000, window: {}, freshness: 'fresh',
};
const DECISIONS_PAGE: DecisionsPage = {
  items: [DECISION], nextCursor: null, asOf: 1_700_000_600_000, window: {}, freshness: 'fresh',
};

/** Boot-safe canned BotResultsReadPort — no I/O. */
export class MockBotResultsAdapter implements BotResultsReadPort {
  async listBotRuns(_filter?: BotRunsFilter): Promise<readonly BotRunRecord[]> { return [RUN]; }
  async getClosedTrades(_runId: string): Promise<readonly ClosedTrade[]> { return [TRADE]; }
  async getRunSummary(_runId: string): Promise<RunSummary> { return SUMMARY; }
  async getOperationalEvents(_runId: string, _cursor?: string): Promise<EventsPage> { return EVENTS_PAGE; }
  async getDecisionLog(_runId: string, _cursor?: string): Promise<DecisionsPage> { return DECISIONS_PAGE; }
}
