import type { RunTradesPort } from '../../ports/run-trades.port.ts';
import type { TradeRecord } from '../../domain/research-experiment.ts';

export class FakeRunTradesAdapter implements RunTradesPort {
  private readonly byRun: Map<string, TradeRecord[]>;
  constructor(byRun: Record<string, TradeRecord[]> = {}) {
    this.byRun = new Map(Object.entries(byRun));
  }
  async getRunTrades(runId: string): Promise<TradeRecord[]> {
    return this.byRun.get(runId) ?? [];
  }
}
