import type { TradeEvidenceBundle, TradeEvidenceQuery, TradeEvidenceReadPort } from '../../ports/trade-evidence-read.port.ts';

const BUNDLE: TradeEvidenceBundle = {
  tradeId: 'mock_trade_001',
  runId: 'mock_run_001',
  symbol: 'ESPORTSUSDT',
  side: 'long',
  enteredAtMs: 1_700_000_100_000,
  closedAtMs: 1_700_000_200_000,
  entryPrice: '100.0',
  exitPrice: '101.25',
  realizedPnl: '12.50',
  pnlPct: '1.25',
  holdingDurationMs: 100_000,
  closeReason: 'take_profit',
  lifecycleEvents: [{ tsMs: 1_700_000_100_000, type: 'entry', price: '100.0', qty: '1' }],
  minuteContext: [{ tsMs: 1_700_000_100_000, close: '100.0', volume: '10000', oi: '500000', liquidationsLong: '0', liquidationsShort: '300' }],
};

export class MockTradeEvidenceAdapter implements TradeEvidenceReadPort {
  async getTradeEvidence(query: TradeEvidenceQuery): Promise<readonly TradeEvidenceBundle[]> {
    return query.tradeIds.includes(BUNDLE.tradeId) ? [BUNDLE] : [];
  }
}
