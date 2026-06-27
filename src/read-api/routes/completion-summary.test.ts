import { describe, it, expect } from 'vitest';
import { createReadApp } from '../read-app.ts';
import type { ReadApiDeps } from '../deps.ts';
import { InMemoryHypothesisReadAdapter } from '../../adapters/read/in-memory-hypothesis-read.adapter.ts';
import { InMemoryBacktestReadAdapter } from '../../adapters/read/in-memory-backtest-read.adapter.ts';
import { InMemoryAgentEventReadAdapter } from '../../adapters/read/in-memory-agent-event-read.adapter.ts';
import { AgentActivityProjection } from '../projection.ts';
import { InMemoryAgentEventStream } from '../../adapters/read/in-memory-agent-event-stream.ts';

const TOKEN = 'test-token';
const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

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
    ...over,
  };
}

describe('GET /v1/tasks/:taskId/completion-summary', () => {
  it('401 without a bearer token', async () => {
    const res = await createReadApp(deps()).request('/v1/tasks/t1/completion-summary');
    expect(res.status).toBe(401);
  });

  it('404 for an unknown task (findById returns null)', async () => {
    const res = await createReadApp(deps()).request('/v1/tasks/missing/completion-summary', auth);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('200 + backtest.completed summary — asserts kind/decision/metrics/hypothesis/links', async () => {
    const app = createReadApp(deps({
      researchTasks: {
        findById: async () => ({
          id: 't1',
          taskType: 'backtest.completed',
          status: 'completed',
          source: 'operator',
          correlationId: 'c1',
          createdAt: '2026-06-19T00:00:00.000Z',
          updatedAt: '2026-06-19T00:00:00.000Z',
          payload: {
            backtestRunId: 'b1',
            hypothesisId: 'h1',
            strategyProfileId: 'p1',
            decision: 'PASS',
            reasons: ['strong sharpe', 'positive pnl'],
            cycleDepth: 0,
          },
        }),
      },
      backtests: new InMemoryBacktestReadAdapter([{
        id: 'b1',
        hypothesisId: 'h1',
        strategyProfileId: 'p1',
        status: 'completed',
        metrics: {
          netPnlUsd: 250,
          netPnlPct: 12.5,
          totalTrades: 40,
          winRate: 0.65,
          profitFactor: 2.1,
          maxDrawdownPct: 6,
          expectancyUsd: 6.25,
          sharpe: 1.8,
          topTradeContributionPct: 18,
        },
        createdAt: '2026-06-19T00:00:00.000Z',
        updatedAt: '2026-06-19T00:00:00.000Z',
      }] as never),
      hypotheses: new InMemoryHypothesisReadAdapter([{
        id: 'h1',
        strategyProfileId: 'p1',
        thesis: 'buy the breakout',
        targetBehavior: 'tb',
        ruleAction: { appliesTo: 'long', rules: [{ when: 'x', action: 'skip_entry', params: {} }] },
        requiredFeatures: [],
        validationPlan: 'p',
        expectedEffect: { metric: 'pnl', direction: 'increase' },
        invalidationCriteria: ['c'],
        confidence: 0.72,
        status: 'validated',
        fingerprint: 'fp1',
        proposal: {} as never,
        issues: [],
        contractVersion: 'v1',
        createdAt: '2026-06-19T00:00:00.000Z',
        updatedAt: '2026-06-19T00:00:00.000Z',
      }] as never),
      strategyProfiles: {
        findById: async (id: string) =>
          id === 'p1'
            ? { id: 'p1', coreIdea: 'momentum breakouts', direction: 'long' } as never
            : null,
      },
    }));

    const res = await app.request('/v1/tasks/t1/completion-summary', auth);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      kind: string;
      decision: string;
      metrics: Record<string, unknown>;
      hypothesis: { id: string; thesis: string; confidence: number };
      profile: { id: string; coreIdea: string };
      reasons: string[];
      willRetry: boolean;
      links: Record<string, string>;
    };

    expect(body.kind).toBe('backtest.completed');
    expect(body.decision).toBe('PASS');
    expect(body.metrics.profitFactor).toBe(2.1);
    expect(body.metrics.netPnlUsd).toBe(250);
    expect(body.metrics.winRate).toBe(0.65);
    expect(body.metrics.sharpe).toBe(1.8);
    expect(body.hypothesis.id).toBe('h1');
    expect(body.hypothesis.thesis).toBe('buy the breakout');
    expect(body.hypothesis.confidence).toBe(0.72);
    expect(body.profile).toEqual({ id: 'p1', coreIdea: 'momentum breakouts', direction: 'long' });
    expect(body.reasons).toEqual(['strong sharpe', 'positive pnl']);
    expect(body.willRetry).toBe(false); // PASS — no retry
    expect(body.links.taskId).toBe('t1');
    expect(body.links.profileId).toBe('p1');
    expect(body.links.hypothesisId).toBe('h1');
    expect(body.links.backtestRunId).toBe('b1');
  });

  it('200 + research.run_cycle summary — asserts kind/counts/topHypotheses/links', async () => {
    const validatedHyps = [
      {
        id: 'hA', strategyProfileId: 'p2', thesis: 'Alpha thesis', targetBehavior: 'tb',
        ruleAction: { appliesTo: 'long' as const, rules: [] }, requiredFeatures: [],
        validationPlan: 'p', expectedEffect: { metric: 'pnl', direction: 'increase' as const },
        invalidationCriteria: [], confidence: 0.5, status: 'validated' as const,
        fingerprint: 'fpA', proposal: {} as never, issues: [], contractVersion: 'v1',
        createdAt: '2026-06-19T00:00:01.000Z', updatedAt: '2026-06-19T00:00:01.000Z',
      },
      {
        id: 'hB', strategyProfileId: 'p2', thesis: 'Beta thesis', targetBehavior: 'tb',
        ruleAction: { appliesTo: 'long' as const, rules: [] }, requiredFeatures: [],
        validationPlan: 'p', expectedEffect: { metric: 'pnl', direction: 'increase' as const },
        invalidationCriteria: [], confidence: 0.9, status: 'validated' as const,
        fingerprint: 'fpB', proposal: {} as never, issues: [], contractVersion: 'v1',
        createdAt: '2026-06-19T00:00:02.000Z', updatedAt: '2026-06-19T00:00:02.000Z',
      },
    ];

    const app = createReadApp(deps({
      researchTasks: {
        findById: async () => ({
          id: 'rc1',
          taskType: 'research.run_cycle',
          status: 'completed',
          source: 'operator',
          correlationId: 'c2',
          createdAt: '2026-06-19T00:00:00.000Z',
          updatedAt: '2026-06-19T00:00:00.000Z',
          payload: { strategyProfileId: 'p2' },
        }),
      },
      agentEvents: new InMemoryAgentEventReadAdapter([
        {
          id: 'e1',
          taskId: 'rc1',
          type: 'research.run_cycle.completed',
          payload: { proposed: 5, validated: 2, rejected: 2, deduped: 1, criticReviews: 5 },
          createdAt: '2026-06-19T00:00:05.000Z',
        },
      ]),
      hypotheses: new InMemoryHypothesisReadAdapter(validatedHyps as never),
      strategyProfiles: {
        findById: async (id: string) =>
          id === 'p2'
            ? { id: 'p2', coreIdea: 'trend following', direction: 'long' } as never
            : null,
      },
    }));

    const res = await app.request('/v1/tasks/rc1/completion-summary', auth);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      kind: string;
      counts: Record<string, number>;
      topHypotheses: { id: string }[];
      profile: { id: string; coreIdea: string };
      links: Record<string, string>;
    };

    expect(body.kind).toBe('research.run_cycle');
    expect(body.counts.proposed).toBe(5);
    expect(body.counts.validated).toBe(2);
    expect(body.counts.rejected).toBe(2);
    expect(body.counts.backtestsEnqueued).toBe(2);
    // hB (0.9 confidence) should rank before hA (0.5 confidence)
    expect(body.topHypotheses[0]?.id).toBe('hB');
    expect(body.topHypotheses[1]?.id).toBe('hA');
    expect(body.profile).toEqual({ id: 'p2', coreIdea: 'trend following', direction: 'long' });
    expect(body.links.taskId).toBe('rc1');
    expect(body.links.profileId).toBe('p2');
  });
});
