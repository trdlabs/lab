import { describe, it, expect } from 'vitest';
import { createReadApp } from '../read-app.ts';
import type { ReadApiDeps } from '../deps.ts';
import { InMemoryHypothesisReadAdapter } from '../../adapters/read/in-memory-hypothesis-read.adapter.ts';
import { InMemoryBacktestReadAdapter } from '../../adapters/read/in-memory-backtest-read.adapter.ts';
import { InMemoryAgentEventReadAdapter } from '../../adapters/read/in-memory-agent-event-read.adapter.ts';
import { AgentActivityProjection } from '../projection.ts';
import { InMemoryAgentEventStream } from '../../adapters/read/in-memory-agent-event-stream.ts';
import { InMemoryExperimentReadAdapter } from '../../adapters/read/in-memory-experiment-read.adapter.ts';
import { CYCLE_SCORECARD_SCHEMA_VERSION, type CycleScorecard } from '../../domain/cycle-scorecard.ts';
import type { CycleScorecardRow } from '../../ports/cycle-scorecard.repository.ts';
import { cycleScorecardMarkdownUrl } from '../paths.ts';

const TOKEN = 'test-token';
const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

function makeCycleScorecards(seed: CycleScorecardRow[] = []) {
  const rows = [...seed];
  return {
    upsert: async (r: CycleScorecardRow) => {
      const i = rows.findIndex((x) => x.correlationId === r.correlationId && x.schemaVersion === r.schemaVersion);
      if (i >= 0) rows[i] = r;
      else rows.push(r);
    },
    findByCorrelationAndSchema: async (cid: string, sv: string) => rows.find((r) => r.correlationId === cid && r.schemaVersion === sv) ?? null,
    findByCorrelation: async (cid: string) => rows.filter((r) => r.correlationId === cid),
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
    experiments: new InMemoryExperimentReadAdapter(),
    cycleScorecards: makeCycleScorecards(),
    ...over,
  };
}

function scorecard(over: Partial<CycleScorecard> = {}): CycleScorecard {
  return {
    schemaVersion: CYCLE_SCORECARD_SCHEMA_VERSION,
    correlationId: 'c1', strategyProfileId: 'p1',
    terminalOutcome: { kind: 'accepted', reason: 'pnl_improved' },
    counts: { built: 2, evaluated: 2, eligible: 2, considered: 2, selected: 1, dropped: 0 },
    provenance: { mergeAttempted: true, candidateIncluded: 1, revisionId: 'r1', sourceTaskId: 't1' },
    revisionAssessment: null,
    champion: { revisionId: 'r1', version: 2 },
    selectionBias: { n: 2, considered: 2, selected: 1 },
    roster: [{ hypId: 'h1', lastDecision: 'PASS', terminalStatus: 'merged', considered: true }],
    verdict: { decision: 'accepted', reason: 'pnl_improved' },
    ...over,
  };
}

describe('GET /v1/cycles/:correlationId/scorecard', () => {
  it('401 without a bearer token', async () => {
    const res = await createReadApp(deps()).request('/v1/cycles/c1/scorecard');
    expect(res.status).toBe(401);
  });

  it('200 + payload for a persisted scorecard', async () => {
    const sc = scorecard();
    const row: CycleScorecardRow = {
      id: 'row-1', correlationId: 'c1', strategyProfileId: 'p1', schemaVersion: CYCLE_SCORECARD_SCHEMA_VERSION,
      payload: sc, generatedAt: '2026-07-14T00:00:00.000Z', createdAt: '2026-07-14T00:00:00.000Z', updatedAt: '2026-07-14T00:00:00.000Z',
    };
    const cycleScorecards = makeCycleScorecards([row]);

    const app = createReadApp(deps({ cycleScorecards }));
    const res = await app.request('/v1/cycles/c1/scorecard', auth);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(sc);
  });

  it('404 for an unknown correlationId', async () => {
    const app = createReadApp(deps({ cycleScorecards: makeCycleScorecards() }));
    const res = await app.request('/v1/cycles/unknown/scorecard', auth);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('405 method-not-allowed on POST — proves the path is registered in V1_PATHS', async () => {
    const app = createReadApp(deps());
    const res = await app.request('/v1/cycles/c1/scorecard', { method: 'POST', ...auth });
    expect(res.status).toBe(405);
  });

  function rowFor(sc = scorecard()): CycleScorecardRow {
    return {
      id: 'row-1', correlationId: sc.correlationId, strategyProfileId: sc.strategyProfileId,
      schemaVersion: CYCLE_SCORECARD_SCHEMA_VERSION, payload: sc,
      generatedAt: '2026-07-14T00:00:00.000Z', createdAt: '2026-07-14T00:00:00.000Z', updatedAt: '2026-07-14T00:00:00.000Z',
    };
  }

  it('?format=markdown returns text/markdown on 200', async () => {
    const app = createReadApp(deps({ cycleScorecards: makeCycleScorecards([rowFor()]) }));
    const res = await app.request('/v1/cycles/c1/scorecard?format=markdown', auth);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect((await res.text()).startsWith('## ')).toBe(true);
  });

  it('?format=markdown on a missing row keeps the JSON 404 envelope', async () => {
    const app = createReadApp(deps({ cycleScorecards: makeCycleScorecards() }));
    const res = await app.request('/v1/cycles/unknown/scorecard?format=markdown', auth);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('default (no format) still returns JSON payload', async () => {
    const app = createReadApp(deps({ cycleScorecards: makeCycleScorecards([rowFor()]) }));
    const res = await app.request('/v1/cycles/c1/scorecard', auth);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('the URL builder path resolves to the same 200 markdown route the app serves (centralization is real)', async () => {
    const app = createReadApp(deps({ cycleScorecards: makeCycleScorecards([rowFor()]) }));
    const res = await app.request(cycleScorecardMarkdownUrl('c1'), auth);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
  });
});
