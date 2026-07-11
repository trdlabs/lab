import type { RunTradesPort } from '../../ports/run-trades.port.ts';
import type { TradeRecord } from '../../domain/research-experiment.ts';

// Demo default: the mock backtester does not run the engine over the fixture → no trades artifact.
export class MockRunTradesAdapter implements RunTradesPort {
  async getRunTrades(): Promise<TradeRecord[]> {
    return [];
  }
  async getBaselineRunTrades(): Promise<TradeRecord[] | null> {
    return null;
  }
}
