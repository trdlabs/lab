import type { ResearchPlatformPort } from '../../ports/research-platform.port.ts';
import { MockResearchPlatformAdapter } from './mock-research-platform.adapter.ts';
import { BacktesterClient } from '@trdlabs/backtester-sdk/client';
import { HttpBacktesterAdapter } from './http-backtester.adapter.ts';

export function selectResearchPlatform(integration: 'mock' | 'backtester'): ResearchPlatformPort {
  if (integration === 'backtester') {
    return new HttpBacktesterAdapter(
      new BacktesterClient({
        baseUrl: process.env.BACKTESTER_API_URL ?? 'http://127.0.0.1:8080',
        token: process.env.BACKTESTER_API_TOKEN ?? '',
      }),
    );
  }
  return new MockResearchPlatformAdapter();
}
