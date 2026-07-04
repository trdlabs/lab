import { HistoricalClient } from '@trdlabs/sdk/historical';
import { HttpMarketHistoryAdapter, type HistoricalRowsSource } from './http-market-history.adapter.ts';
import type { MarketHistoryReadPort } from '../../ports/market-history-read.port.ts';

/** Boot-safe selector for the market-history read surface. Reads its OWN env, never process.env directly. */
export function selectMarketHistory(source: NodeJS.ProcessEnv): MarketHistoryReadPort {
  const baseUrl = source.LAB_MARKET_HISTORY_URL ?? source.LAB_OPS_READ_URL ?? 'http://mock-platform:8839';
  const token = source.LAB_OPS_READ_TOKEN ?? '';
  const client = new HistoricalClient({ baseUrl, token });
  const rowSource: HistoricalRowsSource = {
    queryRows: (args) => client.queryRows(args),
  };
  return new HttpMarketHistoryAdapter(rowSource);
}
