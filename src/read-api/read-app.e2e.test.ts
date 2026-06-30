import { describe, it, expect } from 'vitest';
import { createReadApp } from './read-app.ts';
import { InMemoryHypothesisReadAdapter } from '../adapters/read/in-memory-hypothesis-read.adapter.ts';
import { InMemoryBacktestReadAdapter } from '../adapters/read/in-memory-backtest-read.adapter.ts';
import { InMemoryAgentEventReadAdapter } from '../adapters/read/in-memory-agent-event-read.adapter.ts';
import { AgentActivityProjection } from './projection.ts';
import { InMemoryAgentEventStream } from '../adapters/read/in-memory-agent-event-stream.ts';
import { InMemoryExperimentReadAdapter } from '../adapters/read/in-memory-experiment-read.adapter.ts';

describe('read-app e2e (in-memory wiring)', () => {
  it('serves the full route table behind auth', async () => {
    const app = createReadApp({
      hypotheses: new InMemoryHypothesisReadAdapter([]),
      backtests: new InMemoryBacktestReadAdapter([]),
      agentEvents: new InMemoryAgentEventReadAdapter([]),
      projection: new AgentActivityProjection(50),
      agentStream: new InMemoryAgentEventStream(),
      streamHeartbeatMs: 60_000,
      checkReadiness: async () => true,
      token: 'e2e',
      researchTasks: { findById: async () => null },
      strategyProfiles: { findById: async () => null },
      tokenUsage: { getCost: async () => 0 },
      phoenixTraces: { getAgentTraces: async (agentId: string) => ({ agentId, reasonCode: 'tracing-disabled' as const, traces: [] }) },
      experiments: new InMemoryExperimentReadAdapter(),
    });
    const auth = { authorization: 'Bearer e2e' };
    for (const path of ['/v1/hypotheses', '/v1/backtests', '/v1/agent-events']) {
      const res = await app.request(path, { headers: auth });
      expect(res.status, path).toBe(200);
      expect((await res.json() as { data: unknown }).data).toEqual([]);
    }
    // /v1/agents always returns the fixed 4-agent taxonomy (never empty)
    const agentsRes = await app.request('/v1/agents', { headers: auth });
    expect(agentsRes.status, '/v1/agents').toBe(200);
    expect(Array.isArray((await agentsRes.json() as { data: unknown }).data)).toBe(true);
    expect((await app.request('/healthz')).status).toBe(200);
  });
});
