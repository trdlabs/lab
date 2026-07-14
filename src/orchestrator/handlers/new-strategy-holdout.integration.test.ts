// src/orchestrator/handlers/new-strategy-holdout.integration.test.ts
import { describe, it, expect } from 'vitest';
import { hypothesisBuildHandler } from './hypothesis-build.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import { ExperimentService } from '../../research/experiment-service.ts';
import type { RunNewStrategyValidationInput } from '../../research/experiment-service.ts';
import type { ExperimentRunExecutor, ExperimentRunRequest, ExperimentRunResult } from '../../research/experiment-run-executor.ts';
import type { MemberRole, TradeRecord, ExperimentVerdict } from '../../domain/research-experiment.ts';
import { InMemoryResearchExperimentRepository } from '../../adapters/repository/in-memory-research-experiment.repository.ts';
import { FakeRunTradesAdapter } from '../../adapters/platform/fake-run-trades.adapter.ts';
import { comparisonSummary } from '../../validation/__fixtures__/comparison-summary.ts';
import { createReadApp } from '../../read-api/read-app.ts';
import { InMemoryHypothesisReadAdapter } from '../../adapters/read/in-memory-hypothesis-read.adapter.ts';
import { InMemoryBacktestReadAdapter } from '../../adapters/read/in-memory-backtest-read.adapter.ts';
import { InMemoryAgentEventReadAdapter } from '../../adapters/read/in-memory-agent-event-read.adapter.ts';
import { AgentActivityProjection } from '../../read-api/projection.ts';
import { InMemoryAgentEventStream } from '../../adapters/read/in-memory-agent-event-stream.ts';
import type { ExperimentListQuery, ExperimentReadPort } from '../../ports/experiment-read.port.ts';
import type { ResearchExperiment, ExperimentRunMember } from '../../domain/research-experiment.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { ResearchTask } from '../../domain/types.ts';
import { ParamGridRunner } from '../../research/param-grid-runner.ts';
import { FakeGate1 } from '../../adapters/wfo/fake-gate1.ts';
import { FakeSweepDesigner } from '../../adapters/wfo/fake-sweep-designer.ts';
import { FakeResultInterpreter } from '../../adapters/wfo/fake-result-interpreter.ts';
import { InMemoryStrategyBacktestRunRepository } from '../../adapters/repository/in-memory-strategy-backtest-run.repository.ts';
import { InMemoryCycleScorecardRepository } from '../../adapters/repository/in-memory-cycle-scorecard.repository.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const PLATFORM_RUN = {
  datasetId: 'ds',
  symbols: ['BTCUSDT'],
  timeframe: '1h',
  period: { from: '2023-01-01', to: '2023-06-30' },
  seed: 7,
};
const DAY = 86_400_000;
const START = Date.parse('2023-01-01T00:00:00.000Z');

function trades(n: number): TradeRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    entryTs: START + i * DAY,
    exitTs: START + i * DAY + 3_600_000,
    side: 'long' as const,
    realizedPnl: 1,
  }));
}

function profile(): StrategyProfile {
  const now = '2026-01-01T00:00:00Z';
  return {
    id: 'p1', version: 1, sourceKind: 'manual_description', sourceFingerprint: 'sha256:s',
    direction: 'long', coreIdea: 'oi filter', requiredMarketFeatures: ['oi', 'funding'],
    confidence: 0.6, unknowns: [], profile: {} as never,
    sourceArtifactRef: {} as never, contractVersion: 'strategy-profile-v1',
    createdAt: now, updatedAt: now,
  };
}

function hypothesis(): HypothesisProposal {
  const now = '2026-01-01T00:00:00Z';
  return {
    id: 'h1', strategyProfileId: 'p1', thesis: 't', targetBehavior: 'filter',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'x', action: 'skip_entry', params: { bars: 2 } }] },
    requiredFeatures: ['oi', 'funding'], validationPlan: 'bt',
    expectedEffect: { metric: 'win_rate', direction: 'increase' },
    invalidationCriteria: ['none'], confidence: 0.5, status: 'validated',
    fingerprint: 'sha256:abc', proposal: {} as never,
    issues: [], contractVersion: 'hypothesis-proposal-v1', createdAt: now, updatedAt: now,
  };
}

function task(payload: Record<string, unknown>): ResearchTask {
  const now = '2026-01-01T00:00:00Z';
  return { id: 't1', taskType: 'hypothesis.build', source: 'operator', correlationId: 'c1', status: 'running', payload, createdAt: now, updatedAt: now };
}

async function seeded(over: Parameters<typeof makeServices>[0] = {}) {
  const s = makeServices(over);
  await s.strategyProfiles.create(profile());
  await s.hypotheses.create(hypothesis());
  return s;
}

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------
class FakeExecutor implements ExperimentRunExecutor {
  constructor(private readonly resultFor: (role: MemberRole) => ExperimentRunResult) {}
  async execute(req: ExperimentRunRequest): Promise<ExperimentRunResult> {
    return this.resultFor(req.role);
  }
}

/** Subclass ExperimentService to capture the result without breaking private members. */
class CapturingExperimentService extends ExperimentService {
  public readonly captured: Array<{ experimentId: string; verdict: ExperimentVerdict }> = [];

  override async runNewStrategyValidation(
    input: RunNewStrategyValidationInput,
  ): Promise<{ experimentId: string; verdict: ExperimentVerdict }> {
    const result = await super.runNewStrategyValidation(input);
    this.captured.push(result);
    return result;
  }
}

/** Bridges InMemoryResearchExperimentRepository → ExperimentReadPort for the read app. */
class ExperimentReadBridge implements ExperimentReadPort {
  constructor(private readonly repo: InMemoryResearchExperimentRepository) {}
  async list(_q: ExperimentListQuery): Promise<ResearchExperiment[]> { return []; }
  async getById(id: string): Promise<ResearchExperiment | null> { return this.repo.findById(id); }
  async listRuns(id: string): Promise<ExperimentRunMember[]> { return this.repo.listMembers(id); }
}

function ok(role: MemberRole): ExperimentRunResult {
  return { status: 'completed', runId: `r-${role}`, platformRunId: `plat-${role}`, comparison: comparisonSummary('strong'), totalTrades: 90 };
}

function buildSvc(
  resultFor: (role: MemberRole) => ExperimentRunResult,
  tradesByRun: Record<string, TradeRecord[]>,
): { svc: CapturingExperimentService; experiments: InMemoryResearchExperimentRepository } {
  const experiments = new InMemoryResearchExperimentRepository();
  const runTrades = new FakeRunTradesAdapter(tradesByRun);
  let counter = 0;
  const strategyRunExecutor = { execute: async () => { throw new Error('strategyRunExecutor must not be called from runNewStrategyValidation'); } };
  const svc = new CapturingExperimentService({
    experiments,
    runTrades,
    runExecutor: new FakeExecutor(resultFor),
    strategyRunExecutor,
    newId: (p) => `${p}-${++counter}`,
    now: () => '2026-01-01T00:00:00.000Z',
    events: { append: async () => {}, listByTask: async () => [] },
    gate1: new FakeGate1(),
    sweepDesigner: new FakeSweepDesigner(),
    resultInterpreter: new FakeResultInterpreter(),
    paramGridRunner: new ParamGridRunner({ strategyRunExecutor }),
    strategyBacktests: new InMemoryStrategyBacktestRunRepository(),
  });
  return { svc, experiments };
}

const TOKEN = 'test-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('new-strategy holdout reroute (cycleDepth === 0)', () => {
  it('cycleDepth=0 routes to ExperimentService, sanity+train+holdout created, PAPER_CANDIDATE', async () => {
    const { svc, experiments } = buildSvc(ok, { 'plat-sanity': trades(90) });
    const s = await seeded({ experiments, experimentService: svc });
    await hypothesisBuildHandler(task({ hypothesisId: 'h1', platformRun: PLATFORM_RUN, cycleDepth: 0 }), s);

    expect(svc.captured).toHaveLength(1);
    const { experimentId, verdict } = svc.captured[0]!;
    expect(verdict).toBe('PAPER_CANDIDATE');

    const members = await experiments.listMembers(experimentId);
    expect(members.map((m) => m.role)).toEqual(['sanity', 'train', 'holdout']);
  });

  it('holdout FAIL → verdict=FAIL, not PAPER_CANDIDATE', async () => {
    const { svc, experiments } = buildSvc(
      (role) => ({ status: 'completed', runId: `r-${role}`, platformRunId: `plat-${role}`, comparison: comparisonSummary(role === 'holdout' ? 'fail' : 'strong'), totalTrades: 90 }),
      { 'plat-sanity': trades(90) },
    );
    const s = await seeded({ experiments, experimentService: svc });
    await hypothesisBuildHandler(task({ hypothesisId: 'h1', platformRun: PLATFORM_RUN, cycleDepth: 0 }), s);

    expect(svc.captured).toHaveLength(1);
    expect(svc.captured[0]!.verdict).toBe('FAIL');

    const exp = await experiments.findById(svc.captured[0]!.experimentId);
    expect(exp?.verdict).toBe('FAIL');
    expect(exp?.verdictReason).toBe('holdout_failed');
  });

  it('cycleDepth=1 stays on single-backtest path — ExperimentService NOT called', async () => {
    const { svc } = buildSvc(ok, {});
    const { MockResearchPlatformAdapter } = await import('../../adapters/platform/mock-research-platform.adapter.ts');
    const s = await seeded({ experimentService: svc, researchPlatform: new MockResearchPlatformAdapter() });
    await hypothesisBuildHandler(task({ hypothesisId: 'h1', platformRun: PLATFORM_RUN, cycleDepth: 1 }), s);

    expect(svc.captured).toHaveLength(0);
    const runs = await s.backtests.listByHypothesis('h1');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('evaluated');
  });

  it('GET /v1/experiments/:id/runs lists 3 members after PAPER_CANDIDATE run', async () => {
    const { svc, experiments } = buildSvc(ok, { 'plat-sanity': trades(90) });
    const s = await seeded({ experiments, experimentService: svc });
    await hypothesisBuildHandler(task({ hypothesisId: 'h1', platformRun: PLATFORM_RUN }), s);

    const experimentId = svc.captured[0]!.experimentId;

    const readApp = createReadApp({
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
      experiments: new ExperimentReadBridge(experiments),
      cycleScorecards: new InMemoryCycleScorecardRepository(),
    });

    const res = await readApp.request(`/v1/experiments/${experimentId}/runs`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ role: string }> };
    expect(body.data).toHaveLength(3);
    expect(body.data.map((r) => r.role)).toEqual(['sanity', 'train', 'holdout']);
  });

  it('omitted cycleDepth → schema .default(0) still routes to the holdout flow', async () => {
    // no cycleDepth → schema .default(0) must still route to the holdout flow
    const { svc, experiments } = buildSvc(ok, { 'plat-sanity': trades(90) });
    const s = await seeded({ experiments, experimentService: svc });
    await hypothesisBuildHandler(task({ hypothesisId: 'h1', platformRun: PLATFORM_RUN }), s);

    expect(svc.captured).toHaveLength(1);
    const members = await experiments.listMembers(svc.captured[0]!.experimentId);
    expect(members).toHaveLength(3);
  });
});
