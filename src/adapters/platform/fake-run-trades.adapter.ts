import type { RunTradesPort } from '../../ports/run-trades.port.ts';
import type { TradeRecord } from '../../domain/research-experiment.ts';

export class FakeRunTradesAdapter implements RunTradesPort {
  private readonly byRun: Map<string, TradeRecord[]>;
  private readonly baselineByRun: Map<string, TradeRecord[]>;
  constructor(byRun: Record<string, TradeRecord[]> = {}, baselineByRun: Record<string, TradeRecord[]> = {}) {
    this.byRun = new Map(Object.entries(byRun));
    this.baselineByRun = new Map(Object.entries(baselineByRun));
  }
  async getRunTrades(runId: string): Promise<TradeRecord[]> {
    return this.byRun.get(runId) ?? [];
  }
  async getBaselineRunTrades(comparisonRunId: string): Promise<TradeRecord[] | null> {
    return this.baselineByRun.has(comparisonRunId) ? this.baselineByRun.get(comparisonRunId)! : null;
  }
}
