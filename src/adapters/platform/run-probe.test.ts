import { describe, it, expect } from 'vitest';
import { runBacktestProbe } from './run-probe.ts';
import { MockResearchPlatformAdapter } from './mock-research-platform.adapter.ts';
import type { AgentEvent, AgentEventRepository } from '../../ports/agent-event.repository.ts';
import type { ModuleBundle } from '../../domain/module-bundle.ts';

class InMemoryEvents implements AgentEventRepository {
  readonly events: AgentEvent[] = [];
  async append(e: AgentEvent): Promise<void> { this.events.push(e); }
  async listByTask(): Promise<AgentEvent[]> { return this.events; }
}

const bundle = { manifest: { moduleId: 'm1' }, files: {}, bundleHash: 'sha256:x', bundleContractVersion: '1' } as unknown as ModuleBundle;
const opts = { target: { kind: 'baseline_ref' as const, moduleRef: { id: 'strategy:p1', version: '1.0.0' } }, run: { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2023-01-01', to: '2023-12-31' }, seed: 7 } };

describe('runBacktestProbe', () => {
  it('drives the mock lifecycle to a completed comparison and emits ordered platform.run.* events', async () => {
    const events = new InMemoryEvents();
    const { outcome, comparison } = await runBacktestProbe({
      platform: new MockResearchPlatformAdapter(), events, probeId: 'probe:1', integration: 'mock', bundle, opts,
      poll: { maxPolls: 3, pollDelayMs: 0, sleep: async () => {} },
    });
    expect(outcome.status).toBe('completed');
    expect(comparison).toBeDefined();
    expect(comparison!.variant.totalTrades).toBeGreaterThan(0);
    const types = events.events.map((e) => e.type);
    expect(types).toContain('platform.run.started');
    expect(types).toContain('platform.run.submitted');
    expect(types).toContain('platform.run.completed');
  });
});
