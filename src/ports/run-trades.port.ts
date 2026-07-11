import type { TradeRecord } from '../domain/research-experiment.ts';

export interface RunTradesPort {
  /** Fetch the per-trade records for a completed backtest run (paged + parsed). */
  getRunTrades(runId: string): Promise<TradeRecord[]>;
  /**
   * Fetch the BASELINE leg's per-trade records from a comparison run's manifest.
   * `comparisonRunId` is the variant/headline run id (the manifest is keyed by it).
   * Returns null when the run carries no baseline-trades artifact (non-comparison run or
   * a backtester too old to emit it) — the caller treats null as "feature unavailable".
   */
  getBaselineRunTrades(comparisonRunId: string): Promise<TradeRecord[] | null>;
}
