import type {
  BotRunRecord,
  ClosedTrade,
  ClosedTradesAggregate,
  CloseReason,
  RunSummary,
  BotMode,
  BotRunStatus,
  TradeSide,
  BotRunStrategyRef,
  OpsSeverity,
  OperationalEvent,
  DecisionLogEntry,
} from '@trdlabs/sdk/ops-read';

// Re-export the SDK /ops-read DTOs through the port so adapters depend on lab-local port types,
// not the SDK directly (enforced by sdk-import-boundary.guard.test.ts).
export type {
  BotRunRecord, ClosedTrade, ClosedTradesAggregate, CloseReason, RunSummary,
  BotMode, BotRunStatus, TradeSide, BotRunStrategyRef,
  OpsSeverity, OperationalEvent, DecisionLogEntry,
};

export interface BotRunsFilter {
  readonly mode?: BotMode;
  readonly status?: BotRunStatus;
}

export type FreshnessMarker = 'fresh' | 'stale' | 'degraded';

export interface PageWindow {
  readonly fromMs?: number;
  readonly toMs?: number;
}

export interface PageEnvelope<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly asOf: number;
  readonly window: PageWindow;
  readonly freshness: FreshnessMarker;
}

export type EventsPage = PageEnvelope<OperationalEvent>;
export type DecisionsPage = PageEnvelope<DecisionLogEntry>;

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
  getOperationalEvents(runId: string, cursor?: string): Promise<EventsPage>;
  getDecisionLog(runId: string, cursor?: string): Promise<DecisionsPage>;
}

/** A single live bot run paired with its raw summary + closed trades (raw SDK DTOs, not a derived
 *  summary). The advisory shape the Researcher receives via ResearcherInput.botResults. */
export interface BotRunResultDetail {
  readonly run: BotRunRecord;
  readonly summary: RunSummary;
  readonly trades: readonly ClosedTrade[];
}
