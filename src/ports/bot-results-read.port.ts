import type {
  BotRunRecord,
  ClosedTrade,
  ClosedTradesAggregate,
  RunSummary,
  BotMode,
  BotRunStatus,
  TradeSide,
  BotRunStrategyRef,
} from '@trading-platform/sdk/ops-read';

// Re-export the SDK /ops-read DTOs through the port so adapters depend on lab-local port types,
// not the SDK directly (enforced by sdk-import-boundary.guard.test.ts).
export type {
  BotRunRecord, ClosedTrade, ClosedTradesAggregate, RunSummary,
  BotMode, BotRunStatus, TradeSide, BotRunStrategyRef,
};

export interface BotRunsFilter {
  readonly mode?: BotMode;
  readonly status?: BotRunStatus;
}

/**
 * Live bot-results read surface (ops.3) as seen by trading-lab.
 * Separate from ResearchPlatformPort (the backtest getRunResult path) and from PlatformGatewayPort
 * (the synthetic market-context path). Source-abstracting: live HTTP (Surface A) vs mock vs fixture.
 * Pagination is a Surface A transport detail and does not leak: listBotRuns walks cursor pages internally.
 */
export interface BotResultsReadPort {
  listBotRuns(filter?: BotRunsFilter): Promise<readonly BotRunRecord[]>;
  getClosedTrades(runId: string): Promise<readonly ClosedTrade[]>;
  getRunSummary(runId: string): Promise<RunSummary>;
}
