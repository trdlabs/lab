import { describe, it, expect } from 'vitest';
import { runDiscoveryProbe } from './discovery-probe.ts';
import { ContractIncompatibleError } from './research-contract.ts';
import { ConsoleAgentEventSink } from './console-agent-event-sink.ts';
import { MockResearchPlatformAdapter } from './mock-research-platform.adapter.ts';
import type { ResearchPlatformPort } from '../../ports/research-platform.port.ts';

async function typesOf(sink: ConsoleAgentEventSink, probeId: string): Promise<string[]> {
  return (await sink.listByTask(probeId)).map((e) => e.type);
}

describe('runDiscoveryProbe', () => {
  it('emits started, completed, datasets.listed in order on success', async () => {
    const sink = new ConsoleAgentEventSink();
    const r = await runDiscoveryProbe({
      platform: new MockResearchPlatformAdapter(), events: sink,
      probeId: 'probe:ok', integration: 'mock', command: 'node',
    });
    expect(await typesOf(sink, 'probe:ok')).toEqual([
      'platform.discover.started', 'platform.discover.completed', 'platform.datasets.listed',
    ]);
    expect(r.descriptor.contractVersion).toBeDefined();
    expect(Array.isArray(r.datasets.datasets)).toBe(true);
  });

  it('emits contract.incompatible then failed, and rethrows, on a contract mismatch', async () => {
    const sink = new ConsoleAgentEventSink();
    const bad: ResearchPlatformPort = {
      async discover() { throw new ContractIncompatibleError('031.1', '031.9', ['031.9']); },
      async listDatasets() { return { datasets: [] }; },
      async validateModule() { return { status: 'accepted', issues: [], executed: false }; },
      async submitOverlayRun() { throw new Error('not implemented'); },
      async getRunStatus() { throw new Error('not implemented'); },
      async getRunResult() { throw new Error('not implemented'); },
    };
    await expect(runDiscoveryProbe({
      platform: bad, events: sink, probeId: 'probe:bad', integration: 'mcp', command: 'node',
    })).rejects.toBeInstanceOf(ContractIncompatibleError);
    expect(await typesOf(sink, 'probe:bad')).toEqual([
      'platform.discover.started', 'platform.contract.incompatible', 'platform.discover.failed',
    ]);
  });
});
