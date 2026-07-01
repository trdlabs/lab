// Selector for RunTradesPort. Mirrors select-research-platform.ts.
// Client strategy: a second BacktesterClient is constructed here with the same env-var config
// as selectResearchPlatform. The client is stateless HTTP so two instances are safe and equivalent.
import type { RunTradesPort } from '../../ports/run-trades.port.ts';
import { MockRunTradesAdapter } from './mock-run-trades.adapter.ts';
import { BacktesterClient } from '@trading-backtester/sdk/client';
import { HttpBacktesterRunTradesAdapter } from './http-backtester.adapter.ts';

export function selectRunTrades(integration: 'mock' | 'backtester'): RunTradesPort {
  if (integration === 'backtester') {
    return new HttpBacktesterRunTradesAdapter(
      new BacktesterClient({
        baseUrl: process.env.BACKTESTER_API_URL ?? 'http://127.0.0.1:8080',
        token: process.env.BACKTESTER_API_TOKEN ?? '',
      }),
    );
  }
  return new MockRunTradesAdapter();
}
