import { CONTRACT_VERSION } from '@trading-platform/sdk';
import type { ResearchPlatformPort } from '../../ports/research-platform.port.ts';
import { MockResearchPlatformAdapter } from './mock-research-platform.adapter.ts';
import { LazyMcpResearchPlatformAdapter } from './mcp-research-platform.adapter.ts';
import { loadResearchPlatformConfig, createGatewayTransport } from './mcp-research-transport.ts';
import { BacktesterClient } from '@trading-backtester/sdk/client';
import { HttpBacktesterAdapter } from './http-backtester.adapter.ts';

/**
 * Boot-safe: the mcp branch defers all config loading + transport creation into the per-call
 * connect thunk, so composeRuntime never spawns the gateway and never depends on trading-platform.
 */
export function selectResearchPlatform(integration: 'mock' | 'mcp' | 'backtester'): ResearchPlatformPort {
  if (integration === 'backtester') {
    return new HttpBacktesterAdapter(
      new BacktesterClient({
        baseUrl: process.env.BACKTESTER_API_URL ?? 'http://127.0.0.1:8080',
        token: process.env.BACKTESTER_API_TOKEN ?? '',
      }),
    );
  }
  if (integration === 'mcp') {
    return new LazyMcpResearchPlatformAdapter(
      () => createGatewayTransport(loadResearchPlatformConfig(process.env)),
      process.env.TRADING_PLATFORM_EXPECTED_CONTRACT || CONTRACT_VERSION,
    );
  }
  return new MockResearchPlatformAdapter();
}
