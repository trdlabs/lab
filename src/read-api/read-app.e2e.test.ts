import { describe, it, expect } from 'vitest';
import { createReadApp } from './read-app.ts';
import { InMemoryHypothesisReadAdapter } from '../adapters/read/in-memory-hypothesis-read.adapter.ts';
import { InMemoryBacktestReadAdapter } from '../adapters/read/in-memory-backtest-read.adapter.ts';
import { InMemoryAgentEventReadAdapter } from '../adapters/read/in-memory-agent-event-read.adapter.ts';

describe('read-app e2e (in-memory wiring)', () => {
  it('serves the full route table behind auth', async () => {
    const app = createReadApp({
      hypotheses: new InMemoryHypothesisReadAdapter([]),
      backtests: new InMemoryBacktestReadAdapter([]),
      agentEvents: new InMemoryAgentEventReadAdapter([]),
      checkReadiness: async () => true,
      token: 'e2e',
    });
    const auth = { authorization: 'Bearer e2e' };
    for (const path of ['/v1/hypotheses', '/v1/backtests', '/v1/agent-events']) {
      const res = await app.request(path, { headers: auth });
      expect(res.status, path).toBe(200);
      expect((await res.json() as { data: unknown }).data).toEqual([]);
    }
    expect((await app.request('/healthz')).status).toBe(200);
  });
});
