import type { TradeRecord } from '../domain/research-experiment.ts';

export interface RunTradesPort {
  /** Fetch the per-trade records for a completed backtest run (paged + parsed). */
  getRunTrades(runId: string): Promise<TradeRecord[]>;
}
