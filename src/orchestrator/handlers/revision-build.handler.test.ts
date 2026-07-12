import { describe, it, expect } from 'vitest';
import { revisionBuildHandler } from './revision-build.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import type { AppServices } from '../app-services.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { HypothesisProposal, RuleAction } from '../../domain/hypothesis.ts';
import type { HypothesisBuild } from '../../domain/hypothesis-build.ts';
import type { ModuleManifest, ModuleBundle } from '../../domain/module-bundle.ts';
import type { StrategyRevision } from '../../domain/strategy-revision.ts';
import type { StrategyManifestMeta } from '../../ports/strategy-builder.port.ts';
import type { RevisionRunRequest, RevisionRunResult, StrategyRevisionRunExecutor } from '../../ports/strategy-revision-run-executor.ts';
import type { BacktestMetricBlock } from '../../ports/platform-gateway.port.ts';
import { assembleStrategyBundle, type AssembledStrategyBundle } from '../../domain/strategy-bundle.ts';
import { computeStrategyParamsHash } from '../../research/strategy-run-identity.ts';
import { DEFAULT_HOLDOUT_POLICY, type ResearchExperiment, type ExperimentRunMember } from '../../domain/research-experiment.ts';
import type { StrategyBacktestRun } from '../../domain/strategy-backtest-run.ts';
import { FakeStrategyConsolidator } from '../../adapters/consolidator/fake-strategy-consolidator.ts';
import { InMemoryQueueAdapter } from '../../adapters/queue/in-memory-queue.adapter.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_MANIFEST_META: StrategyManifestMeta = {
  id: 'short_after_pump', version: '0.1.0', name: 'Short after pump', summary: 'Short after a sharp pump.',
  rationale: 'Pumps without fundamentals often revert.',
  paramsSchema: { type: 'object', additionalProperties: false, properties: {} }, params: {},
  capabilities: { platformSdk: true }, dataNeeds: { closedCandlesUpToCurrent: true }, hooks: ['onBarClose'],
};

const BASE_SOURCE = `
export default function createStrategyModule() {
  return {
    onBarClose(ctx) {
      return { kind: 'enter', side: 'short', rationale: 'base-enter' };
    },
  };
}
`;

function functionalOverlaySource(): string {
  return `
export const overlay = function apply(ctx) {
  return { kind: 'pass' };
};
`;
}

function dataOnlyOverlaySource(): string {
  return `
export const overlay = {
  appliesTo: 'short',
  rules: [ { when: 'OI trend persists', action: 'skip_entry', params: { lookback: 3 } } ],
};
`;
}

function moduleManifest(id: string): ModuleManifest {
  return {
    moduleId: id, moduleKind: 'hypothesis_overlay', appliesTo: 'short', entry: 'index.ts',
    exports: ['overlay'], capabilities: [], sdkContractVersion: 'builder-sdk-v0',
  };
}

function task(payload: Record<string, unknown>): ResearchTask {
  return {
    id: 'task-rev-build', taskType: 'revision.build', source: 'operator', correlationId: 'corr-1',
    status: 'running', payload, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

function ruleAction(
  appliesTo: 'short' | 'long',
  action: RuleAction['rules'][number]['action'],
  params: Record<string, string | number | boolean | null> = {},
): RuleAction {
  return { appliesTo, rules: [{ when: 'w', action, params }] };
}

function proposal(id: string, over: Partial<HypothesisProposal> = {}): HypothesisProposal {
  return {
    id, strategyProfileId: 'p1', thesis: `thesis-${id}`, targetBehavior: 'b',
    ruleAction: ruleAction('short', 'skip_entry', { lookback: 1 }),
    requiredFeatures: ['oi'], validationPlan: 'p', expectedEffect: { metric: 'win_rate', direction: 'increase' },
    invalidationCriteria: ['x'], confidence: 0.7, status: 'proxy_passed',
    fingerprint: `sha256:${id}`, proposal: {} as never, issues: [], contractVersion: 'hypothesis-proposal-v1',
    proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 300, deltaMaxDrawdownPct: -2, backtestRunId: `bt-${id}` },
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function baselineMetrics(): BacktestMetricBlock {
  return { netPnlUsd: 500, netPnlPct: 5, totalTrades: 30, winRate: 0.6, profitFactor: 1.5, maxDrawdownPct: 8, expectancyUsd: 16.6, sharpe: 1.2, topTradeContributionPct: 10 };
}
function acceptMetrics(): BacktestMetricBlock {
  return { netPnlUsd: 900, netPnlPct: 9, totalTrades: 30, winRate: 0.6, profitFactor: 1.8, maxDrawdownPct: 9, expectancyUsd: 30, sharpe: 1.5, topTradeContributionPct: 15 };
}
function rejectMetrics(): BacktestMetricBlock {
  // totalTrades < minTrades(20) -> insufficient_sample
  return { netPnlUsd: 100, netPnlPct: 1, totalTrades: 5, winRate: 0.5, profitFactor: 1.0, maxDrawdownPct: 5, expectancyUsd: 2, sharpe: 0.2, topTradeContributionPct: 40 };
}

/** Records every RevisionRunRequest and answers per-label from a scripted queue. */
function makeFakeExecutor(opts: {
  comparison?: { status: 'completed' | 'pending' | 'rejected'; metrics?: BacktestMetricBlock };
  candidateResults?: Array<{ status: 'completed' | 'pending' | 'rejected'; metrics?: BacktestMetricBlock }>;
}): { executor: StrategyRevisionRunExecutor; calls: RevisionRunRequest[] } {
  const calls: RevisionRunRequest[] = [];
  let candidateIdx = 0;
  const comparison = opts.comparison ?? { status: 'completed' as const, metrics: baselineMetrics() };
  const candidateResults = opts.candidateResults ?? [{ status: 'completed' as const, metrics: acceptMetrics() }];
  const executor: StrategyRevisionRunExecutor = {
    execute: async (req: RevisionRunRequest): Promise<RevisionRunResult> => {
      calls.push(req);
      if (req.label === 'comparison_baseline') {
        return {
          status: comparison.status, runId: 'cmp-run', platformRunId: 'plat-cmp',
          ...(comparison.metrics ? { metrics: comparison.metrics, totalTrades: comparison.metrics.totalTrades } : {}),
        };
      }
      const result = candidateResults[Math.min(candidateIdx, candidateResults.length - 1)]!;
      candidateIdx++;
      return {
        status: result.status, runId: `cand-run-${candidateIdx}`, platformRunId: `plat-cand-${candidateIdx}`,
        ...(result.metrics ? { metrics: result.metrics, totalTrades: result.metrics.totalTrades } : {}),
      };
    },
  };
  return { executor, calls };
}

/** Seeds the hypothesis.build task row that a real research.run_cycle would have created for this
 * hypothesis (see research-run-cycle.handler.ts ~line 435) — the cycle-scoping filter in
 * revisionBuildHandler keys off this row's correlationId + payload.hypothesisId. */
async function seedHypothesisBuildTask(services: AppServices, hypothesisId: string, correlationId: string): Promise<void> {
  await services.researchTasks.create({
    id: `build-task-${hypothesisId}`, taskType: 'hypothesis.build', source: 'operator', correlationId,
    status: 'completed', payload: { hypothesisId }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  });
}

async function seedBuild(services: AppServices, hypothesisId: string, source: string): Promise<void> {
  const manifest = moduleManifest(`${hypothesisId}-ov`);
  const bundle: ModuleBundle = {
    manifest, files: { 'index.ts': source }, bundleHash: `sha256:fake-${hypothesisId}`, bundleContractVersion: 'module-bundle-v1',
  };
  const ref = await services.artifacts.put(JSON.stringify(bundle), { kind: 'module_bundle', mime_type: 'application/json', producer: 'test' });
  const build: HypothesisBuild = {
    id: `build-${hypothesisId}`, hypothesisId, strategyProfileId: 'p1', status: 'submitted',
    builderAdapter: 'fake', builderModel: 'fake-model', bundleHash: bundle.bundleHash,
    bundleArtifactRef: ref, manifest, sdkContractVersion: 'builder-sdk-v0', bundleContractVersion: 'module-bundle-v1',
    issues: [], attempt: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
  await services.builds.createGenerating(build);
}

async function seedAcceptedV1(services: AppServices, baseBundle: AssembledStrategyBundle): Promise<StrategyRevision> {
  const bundleArtifactRef = await services.artifacts.put(
    JSON.stringify({ source: baseBundle.source, manifest: baseBundle.manifest, bundleHash: baseBundle.bundleHash }),
    { kind: 'strategy_bundle', mime_type: 'application/json', producer: 'test' },
  );
  const accepted: StrategyRevision = {
    id: 'rev-1', strategyProfileId: 'p1', version: 1, hypothesisIds: [], mergedRuleSet: { order: [], rules: [] },
    bundleArtifactRef, bundleHash: baseBundle.bundleHash, status: 'accepted',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
  await services.revisions.create(accepted);
  return accepted;
}

interface Setup {
  services: AppServices;
  calls: RevisionRunRequest[];
  baseBundle: AssembledStrategyBundle;
  accepted: StrategyRevision;
}

async function setup(opts: {
  hypotheses?: HypothesisProposal[];
  overlaySources?: Record<string, string>;
  comparison?: { status: 'completed' | 'pending' | 'rejected'; metrics?: BacktestMetricBlock };
  candidateResults?: Array<{ status: 'completed' | 'pending' | 'rejected'; metrics?: BacktestMetricBlock }>;
  seedExistingBaselineRun?: boolean;
  revisionBatchMax?: number;
  /** Per-hypothesis override for the correlationId of its seeded hypothesis.build task row.
   * Defaults to 'corr-1' (matching every test's triggering task()) — override to simulate a
   * hypothesis whose build happened in a different (foreign) research cycle. */
  hypothesisCorrelationIds?: Record<string, string>;
  /** slice G3b Task 7: consolidation-trigger overrides; default to makeServices' own defaults
   * (consolidator null, consolidationDepthThreshold 0) so every pre-existing test stays inert. */
  consolidator?: AppServices['consolidator'];
  consolidationDepthThreshold?: number;
} = {}): Promise<Setup> {
  const { executor, calls } = makeFakeExecutor({ comparison: opts.comparison, candidateResults: opts.candidateResults });
  const services = makeServices({
    revisionRunExecutor: executor,
    revisionBatchMax: opts.revisionBatchMax ?? 5,
    consolidator: opts.consolidator ?? null,
    consolidationDepthThreshold: opts.consolidationDepthThreshold ?? 0,
  });

  const baseBundle = await assembleStrategyBundle({ source: BASE_SOURCE, manifestMeta: BASE_MANIFEST_META });
  const accepted = await seedAcceptedV1(services, baseBundle);

  for (const p of opts.hypotheses ?? []) {
    await services.hypotheses.create(p);
    const source = opts.overlaySources?.[p.id] ?? functionalOverlaySource();
    await seedBuild(services, p.id, source);
    // Cycle-scoping fix (Finding: revision.build is not cycle-scoped): revisionBuildHandler now
    // filters listByStrategyProfile results down to hypotheses with a hypothesis.build task row
    // in the triggering correlationId. Every pre-existing test in this file triggers with
    // correlationId 'corr-1' (see task()), so seeding each hypothesis's task row at 'corr-1' by
    // default keeps them all in-cycle and unaffected by the fix — deliberate, documented here.
    await seedHypothesisBuildTask(services, p.id, opts.hypothesisCorrelationIds?.[p.id] ?? 'corr-1');
  }

  if (opts.seedExistingBaselineRun) {
    const paramsHash = computeStrategyParamsHash({ bundleHash: baseBundle.bundleHash, platformRun: services.defaultPlatformRun, params: {} });
    const run: StrategyBacktestRun = {
      id: 'existing-baseline-run', strategyProfileId: 'p1', strategyBundleId: baseBundle.manifest.id,
      bundleHash: baseBundle.bundleHash, paramsHash, runKind: 'revision_combo', platformRunId: 'plat-existing',
      correlationId: 'corr-1', params: {}, status: 'completed', metrics: opts.comparison?.metrics ?? baselineMetrics(),
      platformRun: services.defaultPlatformRun, artifactRefs: [], platformContractVersion: '1', sdkContractVersion: '1',
      backend: 'research_platform', submittedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
    await services.strategyBacktests.createSubmitted(run);
  }

  return { services, calls, baseBundle, accepted };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('revisionBuildHandler', () => {
  it('happy path: composes both hypotheses, candidate ACCEPTs, revision accepted + hypotheses merged', async () => {
    const h1 = proposal('h1', { ruleAction: ruleAction('short', 'skip_entry', { lookback: 1 }), proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 400, deltaMaxDrawdownPct: -2, backtestRunId: 'bt-h1' } });
    const h2 = proposal('h2', { ruleAction: ruleAction('long', 'tighten_stop', { pct: 1 }), proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 200, deltaMaxDrawdownPct: -1, backtestRunId: 'bt-h2' } });
    const { services, calls } = await setup({
      hypotheses: [h1, h2],
      candidateResults: [{ status: 'completed', metrics: acceptMetrics() }],
    });

    await revisionBuildHandler(task({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

    const revisions = await services.revisions.listByProfile('p1');
    const v2 = revisions.find((r) => r.version === 2);
    expect(v2).toBeDefined();
    expect(v2!.status).toBe('accepted');
    expect(v2!.hypothesisIds.sort()).toEqual(['h1', 'h2']);
    expect(v2!.baseRevisionId).toBe('rev-1');

    const updatedH1 = await services.hypotheses.findById('h1');
    const updatedH2 = await services.hypotheses.findById('h2');
    expect(updatedH1?.status).toBe('merged');
    expect(updatedH2?.status).toBe('merged');

    const events = (await services.events.listByTask('task-rev-build')).map((e) => e.type);
    expect(events).toContain('revision.candidate_built');
    expect(events).toContain('revision.accepted');

    const candidateCalls = calls.filter((c) => c.label === 'candidate');
    expect(candidateCalls).toHaveLength(1);
  });

  it('[P0-3] a rejected/stranded revision at the next version does not wedge the lane — a fresh version is allocated', async () => {
    const h1 = proposal('h1', { ruleAction: ruleAction('short', 'skip_entry', { lookback: 1 }), proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 400, deltaMaxDrawdownPct: -2, backtestRunId: 'bt-h1' } });
    const { services } = await setup({ hypotheses: [h1], candidateResults: [{ status: 'completed', metrics: acceptMetrics() }] });

    // A prior cycle's candidate at v2 rejected (or a crashed attempt's stranded 'candidate'): it
    // occupies version 2. With `accepted.version + 1` allocation the next build recomputes v2,
    // collides on UNIQUE(profileId, version), and skips as 'concurrent_revision' — wedging the lane.
    await services.revisions.create({
      id: 'rev-2-rejected', strategyProfileId: 'p1', version: 2, hypothesisIds: [],
      mergedRuleSet: { order: [], rules: [] }, status: 'rejected',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });

    await revisionBuildHandler(task({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

    const revisions = await services.revisions.listByProfile('p1');
    const v3 = revisions.find((r) => r.version === 3);
    expect(v3).toBeDefined();
    expect(v3!.status).toBe('accepted');

    const events = (await services.events.listByTask('task-rev-build')).map((e) => e.type);
    expect(events).not.toContain('revision.skipped'); // no concurrent_revision wedge
    expect(events).toContain('revision.accepted');
  });

  it('conflict-drop: later-scored conflicting hypothesis is dropped_merge_conflict, winner still composes', async () => {
    const winner = proposal('h1', { ruleAction: ruleAction('short', 'skip_entry', { lookback: 1 }), proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 500, deltaMaxDrawdownPct: -2, backtestRunId: 'bt-h1' } });
    const loser = proposal('h3', { ruleAction: ruleAction('short', 'skip_entry', { lookback: 5 }), proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 100, deltaMaxDrawdownPct: -1, backtestRunId: 'bt-h3' } });
    const { services } = await setup({
      hypotheses: [winner, loser],
      candidateResults: [{ status: 'completed', metrics: acceptMetrics() }],
    });

    await revisionBuildHandler(task({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

    const loserAfter = await services.hypotheses.findById('h3');
    expect(loserAfter?.status).toBe('dropped_merge_conflict');

    const revisions = await services.revisions.listByProfile('p1');
    const v2 = revisions.find((r) => r.version === 2)!;
    expect(v2.hypothesisIds).toEqual(['h1']);
    expect(v2.dropped).toEqual(expect.arrayContaining([
      expect.objectContaining({ hypothesisId: 'h3', reason: 'merge_conflict_dropped' }),
    ]));

    const events = (await services.events.listByTask('task-rev-build'))
      .filter((e) => e.type === 'revision.hypothesis_dropped');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ hypothesisId: 'h3', reason: 'merge_conflict_dropped' }) }),
    ]));
  });

  it('unsupported-shape-drop: Style-A (data-only) overlay is dropped_unsupported_shape, functional overlay still composes', async () => {
    const functional = proposal('h1', { proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 400, deltaMaxDrawdownPct: -2, backtestRunId: 'bt-h1' } });
    const dataOnly = proposal('h4', { ruleAction: ruleAction('long', 'tighten_stop', { pct: 2 }), proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 300, deltaMaxDrawdownPct: -1, backtestRunId: 'bt-h4' } });
    const { services } = await setup({
      hypotheses: [functional, dataOnly],
      overlaySources: { h1: functionalOverlaySource(), h4: dataOnlyOverlaySource() },
      candidateResults: [{ status: 'completed', metrics: acceptMetrics() }],
    });

    await revisionBuildHandler(task({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

    const dataOnlyAfter = await services.hypotheses.findById('h4');
    expect(dataOnlyAfter?.status).toBe('dropped_unsupported_shape');

    const revisions = await services.revisions.listByProfile('p1');
    const v2 = revisions.find((r) => r.version === 2)!;
    expect(v2.hypothesisIds).toEqual(['h1']);
    expect(v2.dropped).toEqual(expect.arrayContaining([
      expect.objectContaining({ hypothesisId: 'h4', reason: 'unsupported_module_shape' }),
    ]));
  });

  it('greedy degradation: 1 retry then ACCEPT — worst (last score-order) hypothesis dropped_combo_fail', async () => {
    const h1 = proposal('h1', { proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 500, deltaMaxDrawdownPct: -2, backtestRunId: 'bt-h1' } });
    const h2 = proposal('h2', { ruleAction: ruleAction('long', 'tighten_stop', { pct: 1 }), proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 200, deltaMaxDrawdownPct: -1, backtestRunId: 'bt-h2' } });
    const { services, calls } = await setup({
      hypotheses: [h1, h2],
      candidateResults: [
        { status: 'completed', metrics: rejectMetrics() }, // both included -> REJECT
        { status: 'completed', metrics: acceptMetrics() },  // h2 (worst) dropped -> ACCEPT
      ],
    });

    await revisionBuildHandler(task({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

    const h2After = await services.hypotheses.findById('h2');
    expect(h2After?.status).toBe('dropped_combo_fail');
    const h1After = await services.hypotheses.findById('h1');
    expect(h1After?.status).toBe('merged');

    const revisions = await services.revisions.listByProfile('p1');
    const v2 = revisions.find((r) => r.version === 2)!;
    expect(v2.status).toBe('accepted');
    expect(v2.hypothesisIds).toEqual(['h1']);
    expect(v2.dropped).toEqual(expect.arrayContaining([
      expect.objectContaining({ hypothesisId: 'h2', reason: 'combo_fail_dropped' }),
    ]));

    const candidateCalls = calls.filter((c) => c.label === 'candidate');
    expect(candidateCalls).toHaveLength(2);
  });

  it('greedy exhausted: all candidate runs REJECT — revision rejected within the <=3 candidate run budget', async () => {
    const h1 = proposal('h1', { proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 500, deltaMaxDrawdownPct: -2, backtestRunId: 'bt-h1' } });
    const h2 = proposal('h2', { ruleAction: ruleAction('long', 'scale_in', { pct: 1 }), proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 300, deltaMaxDrawdownPct: -1, backtestRunId: 'bt-h2' } });
    const h3 = proposal('h5', { ruleAction: ruleAction('long', 'scale_out', { pct: 2 }), proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 100, deltaMaxDrawdownPct: 0, backtestRunId: 'bt-h5' } });
    const { services, calls } = await setup({
      hypotheses: [h1, h2, h3],
      candidateResults: [
        { status: 'completed', metrics: rejectMetrics() },
        { status: 'completed', metrics: rejectMetrics() },
        { status: 'completed', metrics: rejectMetrics() },
      ],
    });

    await revisionBuildHandler(task({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

    const revisions = await services.revisions.listByProfile('p1');
    const v2 = revisions.find((r) => r.version === 2)!;
    expect(v2.status).toBe('rejected');
    expect((v2.verdictReason ?? '').length).toBeGreaterThan(0);

    // Budget guard: at most 3 candidate runs total, regardless of 3 starting hypotheses + 2 retries.
    const candidateCalls = calls.filter((c) => c.label === 'candidate');
    expect(candidateCalls.length).toBeLessThanOrEqual(3);
    expect(candidateCalls).toHaveLength(3);

    const events = (await services.events.listByTask('task-rev-build')).map((e) => e.type);
    expect(events).toContain('revision.rejected');

    // No one is left un-adjudicated: h1 was never merged (overall REJECT), the two worst got dropped.
    const h1After = await services.hypotheses.findById('h1');
    expect(h1After?.status).not.toBe('merged');
  });

  it('comparison-baseline: run performed when no comparable strategy_backtest_run exists yet', async () => {
    const h1 = proposal('h1');
    const { services, calls } = await setup({
      hypotheses: [h1],
      seedExistingBaselineRun: false,
      candidateResults: [{ status: 'completed', metrics: acceptMetrics() }],
    });

    await revisionBuildHandler(task({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

    const comparisonCalls = calls.filter((c) => c.label === 'comparison_baseline');
    expect(comparisonCalls).toHaveLength(1);
  });

  it('comparison-baseline: skipped (no executor call) when a comparable completed run already exists', async () => {
    const h1 = proposal('h1');
    const { services, calls } = await setup({
      hypotheses: [h1],
      seedExistingBaselineRun: true,
      candidateResults: [{ status: 'completed', metrics: acceptMetrics() }],
    });

    await revisionBuildHandler(task({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

    const comparisonCalls = calls.filter((c) => c.label === 'comparison_baseline');
    expect(comparisonCalls).toHaveLength(0);

    const revisions = await services.revisions.listByProfile('p1');
    expect(revisions.find((r) => r.version === 2)!.status).toBe('accepted');
  });

  it('comparison-baseline unavailable: rejects without greedy degradation and without a candidate run', async () => {
    const h1 = proposal('h1');
    const { services, calls } = await setup({
      hypotheses: [h1],
      comparison: { status: 'rejected' },
      candidateResults: [{ status: 'completed', metrics: acceptMetrics() }],
    });

    await revisionBuildHandler(task({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

    const revisions = await services.revisions.listByProfile('p1');
    const v2 = revisions.find((r) => r.version === 2)!;
    expect(v2.status).toBe('rejected');
    expect(v2.verdictReason).toBe('comparison_baseline_unavailable');

    // No candidate run was ever attempted — the INCONCLUSIVE-style short-circuit skips greedy entirely.
    expect(calls.filter((c) => c.label === 'candidate')).toHaveLength(0);

    const events = (await services.events.listByTask('task-rev-build')).map((e) => e.type);
    expect(events).toContain('revision.rejected');
  });

  it('no eligible hypotheses: emits revision.skipped {reason: no_eligible_hypotheses}, no revision row created', async () => {
    const { services } = await setup({ hypotheses: [] });

    await revisionBuildHandler(task({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

    const revisions = await services.revisions.listByProfile('p1');
    expect(revisions.find((r) => r.version === 2)).toBeUndefined();

    const events = await services.events.listByTask('task-rev-build');
    const skip = events.find((e) => e.type === 'revision.skipped');
    expect(skip?.payload).toMatchObject({ reason: 'no_eligible_hypotheses' });
  });

  it('bootstrap-backfill: no accepted revision yet, bootstraps v1 from the latest completed strategy_baseline_validation experiment', async () => {
    const { executor } = makeFakeExecutor({});
    const services = makeServices({ revisionRunExecutor: executor });

    const baseBundle = await assembleStrategyBundle({ source: BASE_SOURCE, manifestMeta: BASE_MANIFEST_META });
    const bundleArtifactRef = await services.artifacts.put(
      JSON.stringify({ source: baseBundle.source, manifest: baseBundle.manifest, bundleHash: baseBundle.bundleHash }),
      { kind: 'strategy_bundle', mime_type: 'application/json', producer: 'test' },
    );

    const holdoutRun: StrategyBacktestRun = {
      id: 'holdout-run', strategyProfileId: 'p1', strategyBundleId: baseBundle.manifest.id,
      bundleHash: baseBundle.bundleHash, paramsHash: 'ph-1', runKind: 'strategy_baseline', platformRunId: 'plat-holdout',
      correlationId: 'corr-baseline', params: {}, status: 'completed', metrics: baselineMetrics(),
      platformRun: services.defaultPlatformRun, artifactRefs: [], platformContractVersion: '1', sdkContractVersion: '1',
      backend: 'research_platform', submittedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
    await services.strategyBacktests.createSubmitted(holdoutRun);

    const baseline: ResearchExperiment = {
      id: 'exp-baseline', experimentKey: 'ek-1', experimentType: 'strategy_baseline_validation',
      strategyProfileId: 'p1', bundleHash: baseBundle.bundleHash, bundleArtifactRef,
      datasetScope: { datasetId: 'ds', symbols: ['BTCUSDT'], timeframe: '1h', period: { from: '2023-01-01', to: '2023-06-30' } },
      holdoutPolicy: DEFAULT_HOLDOUT_POLICY,
      status: 'completed', verdict: 'PASS', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:00:00Z',
    };
    await services.experiments.createExperiment(baseline);
    const member: ExperimentRunMember = {
      id: 'member-1', experimentId: 'exp-baseline', strategyBacktestRunId: 'holdout-run', role: 'holdout',
      periodFrom: '2023-01-01', periodTo: '2023-06-30', symbols: ['BTCUSDT'], paramsHash: 'ph-1',
      bundleHash: baseBundle.bundleHash, createdAt: '2026-01-01T00:00:00Z',
    };
    await services.experiments.addMember(member);

    await revisionBuildHandler(task({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

    const bootstrapped = await services.revisions.findLatestAccepted('p1');
    expect(bootstrapped).not.toBeNull();
    expect(bootstrapped!.version).toBe(1);
    expect(bootstrapped!.comboBacktestRunId).toBe('holdout-run');

    // No eligible hypotheses were seeded, so the handler skips AFTER bootstrapping (not on no_baseline).
    const events = await services.events.listByTask('task-rev-build');
    const skip = events.find((e) => e.type === 'revision.skipped');
    expect(skip?.payload).toMatchObject({ reason: 'no_eligible_hypotheses' });
  });

  it('no baseline anywhere: bootstrap finds nothing, emits revision.skipped {reason: no_baseline}', async () => {
    const services = makeServices();
    await revisionBuildHandler(task({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

    const events = await services.events.listByTask('task-rev-build');
    const skip = events.find((e) => e.type === 'revision.skipped');
    expect(skip?.payload).toMatchObject({ reason: 'no_baseline' });
    expect(await services.revisions.findLatestAccepted('p1')).toBeNull();
  });

  it('throws on invalid payload', async () => {
    const services = makeServices();
    await expect(
      revisionBuildHandler(task({ strategyProfileId: '' }), services),
    ).rejects.toThrow('invalid revision.build payload');
  });

  // Regression (Finding 2): a racing revision.build for the same profile can hit the
  // UNIQUE(strategyProfileId, version) constraint inside revisions.create(). Hypothesis-status
  // writes staged by the merge-conflict/unsupported-shape drop steps must NOT be committed unless
  // that create() call actually succeeds — otherwise those hypotheses are stranded in a dropped_*
  // status with no revision row anywhere explaining why.
  it('revisions.create throwing (version collision): no hypothesis status changed, revision.skipped concurrent_revision, handler does not throw', async () => {
    const winner = proposal('h1', { ruleAction: ruleAction('short', 'skip_entry', { lookback: 1 }), proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 500, deltaMaxDrawdownPct: -2, backtestRunId: 'bt-h1' } });
    const loser = proposal('h3', { ruleAction: ruleAction('short', 'skip_entry', { lookback: 5 }), proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 100, deltaMaxDrawdownPct: -1, backtestRunId: 'bt-h3' } });
    const { services } = await setup({
      hypotheses: [winner, loser],
      candidateResults: [{ status: 'completed', metrics: acceptMetrics() }],
    });

    // Simulate a racing revision.build that already created version 2 for this profile: the
    // guarded create() call below must throw.
    let createCalls = 0;
    services.revisions.create = async () => {
      createCalls++;
      throw new Error('strategy revision already exists for strategyProfileId p1 version 2');
    };

    await expect(
      revisionBuildHandler(task({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services),
    ).resolves.toBeUndefined();

    expect(createCalls).toBeGreaterThan(0);

    // The merge-conflict loser (and the winner) must be untouched — no dropped_merge_conflict,
    // no merged; whatever their pre-handler status was.
    const winnerAfter = await services.hypotheses.findById('h1');
    const loserAfter = await services.hypotheses.findById('h3');
    expect(winnerAfter?.status).toBe('proxy_passed');
    expect(loserAfter?.status).toBe('proxy_passed');

    const events = await services.events.listByTask('task-rev-build');
    const skip = events.find((e) => e.type === 'revision.skipped');
    expect(skip?.payload).toMatchObject({ reason: 'concurrent_revision' });
    expect(events.map((e) => e.type)).not.toContain('revision.hypothesis_dropped');
    expect(events.map((e) => e.type)).not.toContain('revision.candidate_built');

    // No version-2 revision row exists — the guarded create() never durably succeeded.
    const revisions = await services.revisions.listByProfile('p1');
    expect(revisions.find((r) => r.version === 2)).toBeUndefined();
  });

  // Regression (Important finding): revision.build was not cycle-scoped — it swept ALL
  // proxy_passed/proxy_paper_candidate hypotheses of the profile via listByStrategyProfile,
  // including ones built under a DIFFERENT (foreign/old) research cycle's correlationId. That
  // breaks the spec's batch invariant ("hypotheses of a cycle -> one candidate revision"): a
  // foreign-cycle hypothesis could get silently merged into a revision it has nothing to do
  // with. The fix scopes eligibility to hypotheses whose hypothesis.build task row lives in the
  // triggering correlationId chain (services.researchTasks.listByCorrelationAndTypes).
  it('cycle-scoping: only the in-cycle hypothesis (hypothesis.build task in the triggering correlationId) is eligible; a foreign-cycle hypothesis is left untouched', async () => {
    const inCycle = proposal('h1', { ruleAction: ruleAction('short', 'skip_entry', { lookback: 1 }), proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 500, deltaMaxDrawdownPct: -2, backtestRunId: 'bt-h1' } });
    const foreign = proposal('h2', { ruleAction: ruleAction('long', 'tighten_stop', { pct: 1 }), proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 400, deltaMaxDrawdownPct: -1, backtestRunId: 'bt-h2' } });
    const { services } = await setup({
      hypotheses: [inCycle, foreign],
      // h1's build happened in the triggering cycle ('corr-1'); h2's build happened under a
      // different, unrelated research cycle ('corr-OLD-CYCLE') — same strategy profile, but not
      // part of THIS batch.
      hypothesisCorrelationIds: { h1: 'corr-1', h2: 'corr-OLD-CYCLE' },
      candidateResults: [{ status: 'completed', metrics: acceptMetrics() }],
    });

    await revisionBuildHandler(task({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

    const revisions = await services.revisions.listByProfile('p1');
    const v2 = revisions.find((r) => r.version === 2);
    expect(v2).toBeDefined();
    expect(v2!.status).toBe('accepted');
    expect(v2!.hypothesisIds).toEqual(['h1']);

    const inCycleAfter = await services.hypotheses.findById('h1');
    expect(inCycleAfter?.status).toBe('merged');

    // The foreign-cycle hypothesis must be completely untouched: not merged, not dropped, not
    // referenced by the candidate/accepted revision at all — it never entered this batch.
    const foreignAfter = await services.hypotheses.findById('h2');
    expect(foreignAfter?.status).toBe('proxy_passed');
    expect(v2!.hypothesisIds).not.toContain('h2');
    expect((v2!.dropped ?? []).map((d) => d.hypothesisId)).not.toContain('h2');
  });
});

// ---------------------------------------------------------------------------
// slice G3b Task 7: compositionDepth writes + revision.consolidate trigger
// ---------------------------------------------------------------------------

describe('revisionBuildHandler — compositionDepth + consolidation trigger (slice G3b, Task 7)', () => {
  it('writes kind:composed + compositionDepth (parent+1) + semanticParentRevisionId on the accepted candidate', async () => {
    const h1 = proposal('h1', { ruleAction: ruleAction('short', 'skip_entry', { lookback: 1 }), proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 400, deltaMaxDrawdownPct: -2, backtestRunId: 'bt-h1' } });
    const { services, accepted } = await setup({
      hypotheses: [h1],
      candidateResults: [{ status: 'completed', metrics: acceptMetrics() }],
    });

    await revisionBuildHandler(task({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

    const revisions = await services.revisions.listByProfile('p1');
    const v2 = revisions.find((r) => r.version === 2)!;
    expect(v2.kind).toBe('composed');
    expect(v2.compositionDepth).toBe((accepted.compositionDepth ?? 1) + 1);
    expect(v2.semanticParentRevisionId).toBe(accepted.id);
  });

  it('enqueues revision.consolidate when the accepted revision reaches the depth threshold', async () => {
    const h1 = proposal('h1', { ruleAction: ruleAction('short', 'skip_entry', { lookback: 1 }), proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 400, deltaMaxDrawdownPct: -2, backtestRunId: 'bt-h1' } });
    const h2 = proposal('h2', { ruleAction: ruleAction('long', 'tighten_stop', { pct: 1 }), proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 200, deltaMaxDrawdownPct: -1, backtestRunId: 'bt-h2' } });
    // seed accepted base at compositionDepth 1 (seedAcceptedV1 default) so the new candidate
    // lands at depth 2 and ACCEPTs — matching the plan's trigger fixture.
    const { services } = await setup({
      hypotheses: [h1, h2],
      candidateResults: [{ status: 'completed', metrics: acceptMetrics() }],
      consolidator: new FakeStrategyConsolidator(),
      consolidationDepthThreshold: 2,
    });

    await revisionBuildHandler(task({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

    const revisions = await services.revisions.listByProfile('p1');
    const v2 = revisions.find((r) => r.version === 2)!;
    expect(v2.status).toBe('accepted');
    expect(v2.compositionDepth).toBe(2);

    const queued = (services.taskQueue as InMemoryQueueAdapter).queued;
    const consolidateJobs = queued.filter((q) => q.taskType === 'revision.consolidate');
    expect(consolidateJobs).toHaveLength(1);
    expect(consolidateJobs[0]!.dedupeKey).toBe(`revision.consolidate:${v2.id}`);
  });

  it('does not enqueue revision.consolidate when the consolidator is null', async () => {
    const h1 = proposal('h1', { ruleAction: ruleAction('short', 'skip_entry', { lookback: 1 }), proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 400, deltaMaxDrawdownPct: -2, backtestRunId: 'bt-h1' } });
    const { services } = await setup({
      hypotheses: [h1],
      candidateResults: [{ status: 'completed', metrics: acceptMetrics() }],
      consolidator: null,
      consolidationDepthThreshold: 2,
    });

    await revisionBuildHandler(task({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

    const queued = (services.taskQueue as InMemoryQueueAdapter).queued;
    expect(queued.some((q) => q.taskType === 'revision.consolidate')).toBe(false);
  });

  it('does not enqueue revision.consolidate when consolidationDepthThreshold is the 0 kill-switch', async () => {
    const h1 = proposal('h1', { ruleAction: ruleAction('short', 'skip_entry', { lookback: 1 }), proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 400, deltaMaxDrawdownPct: -2, backtestRunId: 'bt-h1' } });
    const { services } = await setup({
      hypotheses: [h1],
      candidateResults: [{ status: 'completed', metrics: acceptMetrics() }],
      consolidator: new FakeStrategyConsolidator(),
      consolidationDepthThreshold: 0,
    });

    await revisionBuildHandler(task({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

    const queued = (services.taskQueue as InMemoryQueueAdapter).queued;
    expect(queued.some((q) => q.taskType === 'revision.consolidate')).toBe(false);
  });

  it('does not enqueue revision.consolidate when the accepted revision is below the depth threshold', async () => {
    const h1 = proposal('h1', { ruleAction: ruleAction('short', 'skip_entry', { lookback: 1 }), proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 400, deltaMaxDrawdownPct: -2, backtestRunId: 'bt-h1' } });
    const { services } = await setup({
      hypotheses: [h1],
      candidateResults: [{ status: 'completed', metrics: acceptMetrics() }],
      consolidator: new FakeStrategyConsolidator(),
      consolidationDepthThreshold: 3, // seedAcceptedV1 has no compositionDepth (defaults 1) -> newDepth 2 < 3
    });

    await revisionBuildHandler(task({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

    const queued = (services.taskQueue as InMemoryQueueAdapter).queued;
    expect(queued.some((q) => q.taskType === 'revision.consolidate')).toBe(false);
  });
});
