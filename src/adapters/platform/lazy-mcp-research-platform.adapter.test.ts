import { describe, it, expect, vi } from 'vitest';
import type { GatewayTransport } from '@trading-platform/sdk/agent';
import { LazyMcpResearchPlatformAdapter } from './mcp-research-platform.adapter.ts';
import type { GatewaySession } from './mcp-research-transport.ts';

const descriptor = { contractVersion: '031.2', supportedContractVersions: ['031.2'], marketDataKinds: [], runModes: [], metricCatalog: [], robustnessCatalog: [] };

function fakeSession(): { session: GatewaySession; closed: () => number } {
  let closes = 0;
  const transport: GatewayTransport = {
    async call(tool) { return tool === 'discover_research_contract' ? descriptor : { datasets: [] }; },
  };
  return { session: { transport, close: async () => { closes += 1; } }, closed: () => closes };
}

describe('LazyMcpResearchPlatformAdapter', () => {
  it('does not connect at construction (boot-safe)', () => {
    const connect = vi.fn(async () => fakeSession().session);
    new LazyMcpResearchPlatformAdapter(connect, '031.2');
    expect(connect).not.toHaveBeenCalled();
  });

  it('connects per call and closes in finally', async () => {
    const fs = fakeSession();
    const connect = vi.fn(async () => fs.session);
    const a = new LazyMcpResearchPlatformAdapter(connect, '031.2');
    const d = await a.discover();
    expect(d.contractVersion).toBe('031.2');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(fs.closed()).toBe(1);
    await a.listDatasets();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(fs.closed()).toBe(2);
  });
});
