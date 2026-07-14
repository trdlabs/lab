import { describe, it, expect } from 'vitest';
import { createReadApp } from '../read-app.ts';
import type { ReadApiDeps } from '../deps.ts';
import { InMemoryHypothesisReadAdapter } from '../../adapters/read/in-memory-hypothesis-read.adapter.ts';
import { InMemoryBacktestReadAdapter } from '../../adapters/read/in-memory-backtest-read.adapter.ts';
import { InMemoryAgentEventReadAdapter } from '../../adapters/read/in-memory-agent-event-read.adapter.ts';
import { AgentActivityProjection } from '../projection.ts';
import { InMemoryAgentEventStream } from '../../adapters/read/in-memory-agent-event-stream.ts';
import { InMemoryExperimentReadAdapter } from '../../adapters/read/in-memory-experiment-read.adapter.ts';
import { DEFAULT_HOLDOUT_POLICY, type ResearchExperiment } from '../../domain/research-experiment.ts';

const TOKEN = 'test-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

function exp(id: string): ResearchExperiment {
  return {
    id, experimentKey: `k-${id}`, experimentType: 'new_strategy_validation', strategyProfileId: 'p1',
    datasetScope: { datasetId: 'd', symbols: ['BTC'], timeframe: '1m', period: { from: 'a', to: 'b' } },
    holdoutPolicy: DEFAULT_HOLDOUT_POLICY, status: 'completed', verdict: 'PAPER_CANDIDATE',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function deps(over: Partial<ReadApiDeps> = {}): ReadApiDeps {
  return {
    hypotheses: new InMemoryHypothesisReadAdapter([]),
    backtests: new InMemoryBacktestReadAdapter([]),
    agentEvents: new InMemoryAgentEventReadAdapter([]),
    projection: new AgentActivityProjection(50),
    agentStream: new InMemoryAgentEventStream(),
    streamHeartbeatMs: 60_000,
    checkReadiness: async () => true,
    token: TOKEN,
    researchTasks: { findById: async () => null },
    strategyProfiles: { findById: async () => null },
    tokenUsage: { getCost: async () => 0 },
    phoenixTraces: { getAgentTraces: async (agentId: string) => ({ agentId, reasonCode: 'tracing-disabled' as const, traces: [] }) },
    experiments: new InMemoryExperimentReadAdapter({ experiments: [exp('a')] }),
    cycleScorecards: { findByCorrelationAndSchema: async () => null, findByCorrelation: async () => [], upsert: async () => {} },
    ...over,
  };
}

describe('experiments read routes', () => {
  it('lists / details / 404 / runs / 401', async () => {
    const app = createReadApp(deps());
    expect((await app.request('/v1/experiments', { headers: AUTH })).status).toBe(200);
    const list = await (await app.request('/v1/experiments', { headers: AUTH })).json();
    expect(list).toEqual({ data: [expect.objectContaining({ id: 'a' })], page: { nextCursor: null, limit: 20 } });
    expect((await app.request('/v1/experiments/a', { headers: AUTH })).status).toBe(200);
    expect((await app.request('/v1/experiments/zzz', { headers: AUTH })).status).toBe(404);
    expect((await app.request('/v1/experiments/a/runs', { headers: AUTH })).status).toBe(200);
    expect((await app.request('/v1/experiments')).status).toBe(401);
  });
});
