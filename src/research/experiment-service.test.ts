import { describe, it, expect } from 'vitest';
import { ExperimentService } from './experiment-service.ts';
import type { ExperimentRunExecutor, ExperimentRunRequest, ExperimentRunResult } from './experiment-run-executor.ts';
import { InMemoryResearchExperimentRepository } from '../adapters/repository/in-memory-research-experiment.repository.ts';
import { FakeRunTradesAdapter } from '../adapters/platform/fake-run-trades.adapter.ts';
import { comparisonSummary } from '../validation/__fixtures__/comparison-summary.ts';
import { DEFAULT_HOLDOUT_POLICY, type MemberRole, type TradeRecord } from '../domain/research-experiment.ts';
import type { ModuleBundle } from '../domain/module-bundle.ts';
import type { Ref } from '../ports/research-platform.port.ts';

const DAY = 86_400_000; const START = Date.parse('2026-01-01T00:00:00.000Z');
function trades(n: number): TradeRecord[] {
  return Array.from({ length: n }, (_, i) => ({ entryTs: START + i * DAY, exitTs: START + i * DAY + 3_600_000, side: 'long' as const, realizedPnl: 1 }));
}

// Minimal valid ModuleBundle — appliesTo must be in DIRECTIONS = ['long','short','both','unknown']
// manifest uses ModuleManifestSchema.strict(), so all required fields must be present with correct types.
const bundle: ModuleBundle = {
  manifest: { moduleId: 'm1', moduleKind: 'hypothesis_overlay', appliesTo: 'long', entry: 'index.ts', exports: ['run'], capabilities: [], sdkContractVersion: '1' },
  files: {}, bundleHash: 'h1', bundleContractVersion: 'c1',
};
// Ref.version is string (research-run-lifecycle.ts); use '1' not 1.
const baselineRef: Ref = { id: 'strategy:p1', version: '1' };

class FakeExecutor implements ExperimentRunExecutor {
  public readonly calls: ExperimentRunRequest[] = [];
  private readonly resultFor: (role: MemberRole) => ExperimentRunResult;
  constructor(resultFor: (role: MemberRole) => ExperimentRunResult) { this.resultFor = resultFor; }
  async execute(req: ExperimentRunRequest): Promise<ExperimentRunResult> { this.calls.push(req); return this.resultFor(req.role); }
}

function svc(resultFor: (role: MemberRole) => ExperimentRunResult, tradesByRun: Record<string, TradeRecord[]>) {
  const experiments = new InMemoryResearchExperimentRepository();
  const executor = new FakeExecutor(resultFor);
  let i = 0;
  const emittedEvents: Array<{ id: string; taskId: string; type: string; payload: Record<string, unknown>; createdAt: string }> = [];
  const service = new ExperimentService({
    experiments, runTrades: new FakeRunTradesAdapter(tradesByRun), runExecutor: executor,
    strategyRunExecutor: { execute: async () => { throw new Error('strategyRunExecutor must not be called from runNewStrategyValidation'); } },
    newId: (p) => `${p}-${++i}`, now: () => '2026-01-01T00:00:00.000Z',
    events: { append: async (e) => { emittedEvents.push(e); }, listByTask: async () => [] },
  });
  return { service, experiments, executor, emittedEvents };
}

const input = {
  strategyProfileId: 'p1', hypothesisId: 'hyp1', buildId: 'b1', bundle, baselineRef,
  taskId: 'task-1',
  datasetScope: { datasetId: 'd', symbols: ['BTC'], timeframe: '1m', period: { from: '2026-01-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' } },
  runConfig: { datasetId: 'd', symbols: ['BTC'], timeframe: '1m', seed: 1 }, params: {},
};
const ok = (role: MemberRole, kind: 'strong' | 'fail', totalTrades: number): ExperimentRunResult =>
  ({ status: 'completed', runId: `lab-${role}`, platformRunId: `plat-${role}`, comparison: comparisonSummary(kind), totalTrades });

describe('ExperimentService.runNewStrategyValidation', () => {
  it('sanity rejected → FAIL/sanity_failed', async () => {
    const { service, experiments } = svc(() => ({ status: 'rejected', runId: 'lab-sanity', platformRunId: 'plat-sanity' }), {});
    const res = await service.runNewStrategyValidation(input);
    expect(res.verdict).toBe('FAIL');
    expect((await experiments.findById(res.experimentId))?.verdictReason).toBe('sanity_failed');
    expect((await experiments.listMembers(res.experimentId)).map((m) => m.role)).toEqual(['sanity']);
  });

  it('insufficient trades → INCONCLUSIVE, boundary none, no train/holdout', async () => {
    const { service, experiments } = svc((role) => ok(role, 'strong', 5), { 'plat-sanity': trades(5) });
    const res = await service.runNewStrategyValidation(input);
    expect(res.verdict).toBe('INCONCLUSIVE');
    expect((await experiments.findById(res.experimentId))?.holdoutBoundary?.mode).toBe('none');
    expect((await experiments.listMembers(res.experimentId)).map((m) => m.role)).toEqual(['sanity']);
  });

  it('train pass + holdout fail → FAIL/holdout_failed, not paper, member backtestRunId is the lab id', async () => {
    const { service, experiments, executor, emittedEvents } = svc((role) => ok(role, role === 'holdout' ? 'fail' : 'strong', role === 'holdout' ? 30 : 90), { 'plat-sanity': trades(90) });
    const res = await service.runNewStrategyValidation(input);
    expect(res.verdict).toBe('FAIL');
    const exp = await experiments.findById(res.experimentId);
    expect(exp?.verdictReason).toBe('holdout_failed');
    const members = await experiments.listMembers(res.experimentId);
    expect(members.map((m) => m.role)).toEqual(['sanity', 'train', 'holdout']);
    expect(members.find((m) => m.role === 'train')?.backtestRunId).toBe('lab-train');

    // --- no-leakage period wiring assertions (Finding 2) ---
    // With 90 trades (one per day), DEFAULT_HOLDOUT_POLICY picks 30 holdout trades.
    // T = the 61st trade's entryTs (sorted[90-30] = sorted[60])
    const fullPeriod = input.datasetScope.period;
    const T = new Date(START + 60 * DAY).toISOString();
    expect(executor.calls.find((c) => c.role === 'sanity')?.run.period).toEqual(fullPeriod);
    expect(executor.calls.find((c) => c.role === 'train')?.run.period).toEqual({ from: fullPeriod.from, to: T });
    expect(executor.calls.find((c) => c.role === 'holdout')?.run.period).toEqual({ from: T, to: fullPeriod.to });

    // --- event stream assertions ---
    expect(emittedEvents.find((e) => e.type === 'experiment.started')?.payload.experimentId).toBe(res.experimentId);
    expect(emittedEvents.find((e) => e.type === 'experiment.completed')?.payload.verdict).toBe('FAIL');
  });

  it('holdout pass → PAPER_CANDIDATE', async () => {
    const { service } = svc((role) => ok(role, 'strong', 90), { 'plat-sanity': trades(90) });
    expect((await service.runNewStrategyValidation(input)).verdict).toBe('PAPER_CANDIDATE');
  });

  it('idempotent: same input → same experiment, executor not re-invoked', async () => {
    const { service, executor } = svc((role) => ok(role, 'strong', 90), { 'plat-sanity': trades(90) });
    const a = await service.runNewStrategyValidation(input);
    const before = executor.calls.length;
    const b = await service.runNewStrategyValidation(input);
    expect(b.experimentId).toBe(a.experimentId);
    expect(executor.calls.length).toBe(before);
  });
});
