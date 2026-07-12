// src/orchestrator/handlers/revision-flow.integration.test.ts
//
// Slice G3 Task 10 integration test: end-to-end revision.build -> activeOverlayRules wiring.
// Seeds a profile + an accepted v1 revision (bootstrap shape: empty rules) + two proxy_passed
// hypotheses, each carrying a FUNCTIONAL overlay module build (hypothesis_build row with
// bundleArtifactRef + manifest — mirrors revision-build.handler.test.ts's fixtures) -> runs
// revisionBuildHandler with a fake StrategyRevisionRunExecutor that returns improving metrics ->
// asserts v2 is accepted, both hypotheses are 'merged', the expected events are emitted, and that
// research-run-cycle.handler.ts's activeOverlayRules source (services.revisions.findLatestAccepted)
// reflects v2's mergedRuleSet when the research cycle handler is run against the SAME services.
import { describe, it, expect, vi } from 'vitest';
import { revisionBuildHandler } from './revision-build.handler.ts';
import { CYCLE_CLOSE_MAX_WAIT_ATTEMPTS } from '../cycle-close.ts';
import { researchRunCycleHandler } from './research-run-cycle.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import type { AppServices } from '../app-services.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { HypothesisProposal, RuleAction, ResearcherOutput } from '../../domain/hypothesis.ts';
import type { HypothesisBuild } from '../../domain/hypothesis-build.ts';
import type { ModuleManifest, ModuleBundle } from '../../domain/module-bundle.ts';
import type { StrategyRevision } from '../../domain/strategy-revision.ts';
import type { StrategyManifestMeta } from '../../ports/strategy-builder.port.ts';
import type { RevisionRunRequest, RevisionRunResult, StrategyRevisionRunExecutor } from '../../ports/strategy-revision-run-executor.ts';
import type { BacktestMetricBlock } from '../../ports/platform-gateway.port.ts';
import { assembleStrategyBundle, type AssembledStrategyBundle } from '../../domain/strategy-bundle.ts';
import type { ResearcherInput, ResearcherPort } from '../../ports/researcher.port.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import { FakeRunTradesAdapter } from '../../adapters/platform/fake-run-trades.adapter.ts';
import { FakeStrategyConsolidator } from '../../adapters/consolidator/fake-strategy-consolidator.ts';

// ---------------------------------------------------------------------------
// Fixtures (mirrors revision-build.handler.test.ts)
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

function moduleManifest(id: string): ModuleManifest {
  return {
    moduleId: id, moduleKind: 'hypothesis_overlay', appliesTo: 'short', entry: 'index.ts',
    exports: ['overlay'], capabilities: [], sdkContractVersion: 'builder-sdk-v0',
  };
}

function buildTask(payload: Record<string, unknown>): ResearchTask {
  return {
    id: 'task-rev-build', taskType: 'revision.build', source: 'operator', correlationId: 'corr-1',
    status: 'running', payload, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

function cycleTask(payload: Record<string, unknown>): ResearchTask {
  return {
    id: 'task-run-cycle', taskType: 'research.run_cycle', source: 'operator', correlationId: 'corr-2',
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

function profile(): StrategyProfile {
  return {
    id: 'p1', version: 1, sourceKind: 'manual_description', sourceFingerprint: 'sha256:p',
    direction: 'long', coreIdea: 'Long OI divergence', requiredMarketFeatures: ['oi'],
    confidence: 0.5, unknowns: [], profile: {} as never, sourceArtifactRef: {} as never,
    contractVersion: 'strategy-profile-v1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

function baselineMetrics(): BacktestMetricBlock {
  return { netPnlUsd: 500, netPnlPct: 5, totalTrades: 30, winRate: 0.6, profitFactor: 1.5, maxDrawdownPct: 8, expectancyUsd: 16.6, sharpe: 1.2, topTradeContributionPct: 10 };
}
function acceptMetrics(): BacktestMetricBlock {
  return { netPnlUsd: 900, netPnlPct: 9, totalTrades: 30, winRate: 0.6, profitFactor: 1.8, maxDrawdownPct: 9, expectancyUsd: 30, sharpe: 1.5, topTradeContributionPct: 15 };
}

/** Records every RevisionRunRequest and answers 'completed' + improving metrics for every call. */
function makeFakeExecutor(): { executor: StrategyRevisionRunExecutor; calls: RevisionRunRequest[] } {
  const calls: RevisionRunRequest[] = [];
  const executor: StrategyRevisionRunExecutor = {
    execute: async (req: RevisionRunRequest): Promise<RevisionRunResult> => {
      calls.push(req);
      if (req.label === 'comparison_baseline') {
        return { status: 'completed', runId: 'cmp-run', platformRunId: 'plat-cmp', metrics: baselineMetrics(), totalTrades: baselineMetrics().totalTrades };
      }
      return { status: 'completed', runId: 'cand-run', platformRunId: 'plat-cand', metrics: acceptMetrics(), totalTrades: acceptMetrics().totalTrades };
    },
  };
  return { executor, calls };
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

function capturingResearcher(out: ResearcherOutput): { port: ResearcherPort; captured: () => ResearcherInput | undefined } {
  let cap: ResearcherInput | undefined;
  return {
    port: { adapter: 'fake', model: 'stub', async propose(inp: ResearcherInput) { cap = inp; return out; } },
    captured: () => cap,
  };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('revision-flow integration (Task 10): revision.build -> activeOverlayRules', () => {
  it('composes+accepts v2 from two proxy_passed hypotheses, then research.run_cycle activeOverlayRules reflects v2 rules', async () => {
    const { executor, calls } = makeFakeExecutor();
    const cap = capturingResearcher({ hypotheses: [], researchSummary: 's' });
    const services = makeServices({ revisionRunExecutor: executor, researcher: cap.port });

    const baseBundle = await assembleStrategyBundle({ source: BASE_SOURCE, manifestMeta: BASE_MANIFEST_META });
    await seedAcceptedV1(services, baseBundle);
    await services.strategyProfiles.create(profile());

    const h1 = proposal('h1', { ruleAction: ruleAction('short', 'skip_entry', { lookback: 1 }), proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 400, deltaMaxDrawdownPct: -2, backtestRunId: 'bt-h1' } });
    const h2 = proposal('h2', { ruleAction: ruleAction('long', 'tighten_stop', { pct: 1 }), proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 200, deltaMaxDrawdownPct: -1, backtestRunId: 'bt-h2' } });
    for (const p of [h1, h2]) {
      await services.hypotheses.create(p);
      await seedBuild(services, p.id, functionalOverlaySource());
      // Cycle-scoping fix: revisionBuildHandler now only considers hypotheses whose
      // hypothesis.build task row lives in the triggering correlationId chain ('corr-1' — the
      // buildTask() below). This fixture previously relied on the unscoped
      // listByStrategyProfile sweep; seed the task rows a real research.run_cycle would have
      // created (research-run-cycle.handler.ts ~line 435) to keep both hypotheses in-cycle.
      await services.researchTasks.create({
        id: `build-task-${p.id}`, taskType: 'hypothesis.build', source: 'operator', correlationId: 'corr-1',
        status: 'completed', payload: { hypothesisId: p.id }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      });
    }

    // --- Step 1: revision.build composes + accepts v2 ---
    await revisionBuildHandler(buildTask({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

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

    const buildEvents = (await services.events.listByTask('task-rev-build')).map((e) => e.type);
    expect(buildEvents).toContain('revision.candidate_built');
    expect(buildEvents).toContain('revision.accepted');

    const candidateCalls = calls.filter((c) => c.label === 'candidate');
    expect(candidateCalls).toHaveLength(1); // straight ACCEPT, no greedy-degradation retries

    // v2's mergedRuleSet carries both rules in score order (h1 higher deltaNetPnlUsd -> first) plus theses.
    expect(v2!.mergedRuleSet).toEqual({
      order: ['h1', 'h2'],
      rules: [h1.ruleAction, h2.ruleAction],
      theses: [h1.thesis, h2.thesis],
    });

    // --- Step 2: research.run_cycle's activeOverlayRules source now reflects v2 (NOT the raw
    //     validated/proxy_passed hypothesis pool -- see the regression pin in
    //     research-run-cycle.handler.test.ts for the negative case). ---
    await researchRunCycleHandler(cycleTask({ strategyProfileId: 'p1' }), services);

    expect(cap.captured()?.activeOverlayRules).toEqual([
      { thesis: h1.thesis, ruleAction: h1.ruleAction, status: 'accepted_revision' },
      { thesis: h2.thesis, ruleAction: h2.ruleAction, status: 'accepted_revision' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Task 6: trade-preservation veto wiring
// ---------------------------------------------------------------------------
//
// Aggregate metrics (BacktestMetricBlock) are independent of the raw per-trade records the
// FakeRunTradesAdapter serves — evaluateRevision's minTrades:20 floor is checked against the
// *aggregate* totalTrades, while the preservation gate's trade-level matching walks the raw
// TradeRecord[] arrays. That split lets this fixture pass evaluateRevision's ladder (ACCEPT)
// while still encoding an abstention-gaming pattern at the trade level.
//
// Hand-checked math against src/validation/trade-preservation.ts (DEFAULT_PRESERVATION_THRESHOLDS:
// winnerRetention 0.9, maxTradeDropPct 20, abstentionShare 0.7, eodShare 0.5, matchToleranceMs 0,
// minWinnerSample 3):
//   totalDelta = 15 - (-45) = 60
//   (1) end_of_data_position: no trade carries closeReason 'end_of_data' -> eodDelta 0;
//       0 >= 0.5*60=30 is false -> does not fire.
//   (2) abstention_gaming: dropPct = ((25-20)/25)*100 = 20 >= maxTradeDropPct(20) -> true.
//       Matching (matchToleranceMs 0, exact entryTs): baseline trades at entryTs 3/4/5 (realizedPnl
//       5 each) match candidate's three trades 1:1; baseline trades at entryTs 1/2 (realizedPnl -30
//       each) have no candidate counterpart -> disappeared. removedLosersPnl = 30+30 = 60.
//       60 >= abstentionShare(0.7)*totalDelta(60)=42 -> true -> FIRES 'abstention_gaming'.
//   (3) winner_degradation: never reached (first-match ladder returns at (2)).
function vetoBaselineMetrics(): BacktestMetricBlock {
  return { netPnlUsd: -45, netPnlPct: -4.5, totalTrades: 25, winRate: 0.4, profitFactor: 0.8, maxDrawdownPct: 10, expectancyUsd: -1.8, sharpe: -0.2, topTradeContributionPct: 20 };
}
function vetoCandidateMetrics(): BacktestMetricBlock {
  return { netPnlUsd: 15, netPnlPct: 1.5, totalTrades: 20, winRate: 0.6, profitFactor: 1.2, maxDrawdownPct: 11, expectancyUsd: 0.75, sharpe: 0.3, topTradeContributionPct: 25 };
}

/** comparison_baseline -> platformRunId 'base-pr'; candidate -> platformRunId 'cand-pr' (fixed
 * metrics regardless of bundle content, so greedy-degradation retries keep re-triggering the veto). */
function makeVetoExecutor(): StrategyRevisionRunExecutor {
  return {
    execute: async (req: RevisionRunRequest): Promise<RevisionRunResult> => {
      if (req.label === 'comparison_baseline') {
        return { status: 'completed', runId: 'cmp-run', platformRunId: 'base-pr', metrics: vetoBaselineMetrics(), totalTrades: vetoBaselineMetrics().totalTrades };
      }
      return { status: 'completed', runId: 'cand-run', platformRunId: 'cand-pr', metrics: vetoCandidateMetrics(), totalTrades: vetoCandidateMetrics().totalTrades };
    },
  };
}

/** comparison_baseline -> 'base-pr' (net 500); candidate -> 'cand-pr' (net 400 < baseline, so
 * evaluateRevision REJECTs 'no_improvement_over_accepted' before the gate is consulted). */
function makeRejectExecutor(): StrategyRevisionRunExecutor {
  const baseline: BacktestMetricBlock = { netPnlUsd: 500, netPnlPct: 5, totalTrades: 30, winRate: 0.6, profitFactor: 1.5, maxDrawdownPct: 8, expectancyUsd: 16.6, sharpe: 1.2, topTradeContributionPct: 10 };
  const candidate: BacktestMetricBlock = { netPnlUsd: 400, netPnlPct: 4, totalTrades: 30, winRate: 0.55, profitFactor: 1.3, maxDrawdownPct: 8, expectancyUsd: 13, sharpe: 1.0, topTradeContributionPct: 12 };
  return {
    execute: async (req: RevisionRunRequest): Promise<RevisionRunResult> => {
      if (req.label === 'comparison_baseline') {
        return { status: 'completed', runId: 'cmp-run', platformRunId: 'base-pr', metrics: baseline, totalTrades: baseline.totalTrades };
      }
      return { status: 'completed', runId: 'cand-run', platformRunId: 'cand-pr', metrics: candidate, totalTrades: candidate.totalTrades };
    },
  };
}

async function seedTwoHypotheses(services: AppServices): Promise<void> {
  await services.strategyProfiles.create(profile());
  const h1 = proposal('h1', { ruleAction: ruleAction('short', 'skip_entry', { lookback: 1 }), proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 400, deltaMaxDrawdownPct: -2, backtestRunId: 'bt-h1' } });
  const h2 = proposal('h2', { ruleAction: ruleAction('long', 'tighten_stop', { pct: 1 }), proxyMetrics: { decision: 'PASS', deltaNetPnlUsd: 200, deltaMaxDrawdownPct: -1, backtestRunId: 'bt-h2' } });
  for (const p of [h1, h2]) {
    await services.hypotheses.create(p);
    await seedBuild(services, p.id, functionalOverlaySource());
    await services.researchTasks.create({
      id: `build-task-${p.id}`, taskType: 'hypothesis.build', source: 'operator', correlationId: 'corr-1',
      status: 'completed', payload: { hypothesisId: p.id }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
  }
}

describe('revision-flow integration (Task 6): trade-preservation veto', () => {
  it('vetoes an abstention-gamed combo: ACCEPT downgraded to rejected + preservationGate persisted', async () => {
    const runTrades = new FakeRunTradesAdapter({
      'base-pr': [
        { entryTs: 1, exitTs: 2, side: 'long', realizedPnl: -30 },
        { entryTs: 2, exitTs: 3, side: 'long', realizedPnl: -30 },
        { entryTs: 3, exitTs: 4, side: 'long', realizedPnl: 5 },
        { entryTs: 4, exitTs: 5, side: 'long', realizedPnl: 5 },
        { entryTs: 5, exitTs: 6, side: 'long', realizedPnl: 5 },
      ],
      'cand-pr': [
        { entryTs: 3, exitTs: 4, side: 'long', realizedPnl: 5 },
        { entryTs: 4, exitTs: 5, side: 'long', realizedPnl: 5 },
        { entryTs: 5, exitTs: 6, side: 'long', realizedPnl: 5 },
      ],
    });
    const cap = capturingResearcher({ hypotheses: [], researchSummary: 's' });
    const services = makeServices({ revisionRunExecutor: makeVetoExecutor(), researcher: cap.port, runTrades });

    const baseBundle = await assembleStrategyBundle({ source: BASE_SOURCE, manifestMeta: BASE_MANIFEST_META });
    await seedAcceptedV1(services, baseBundle);
    await seedTwoHypotheses(services);

    await revisionBuildHandler(buildTask({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

    const revisions = await services.revisions.listByProfile('p1');
    const v2 = revisions.find((r) => r.version === 2);
    expect(v2).toBeDefined();
    expect(v2!.status).toBe('rejected');
    expect(v2!.preservationGate?.fired).toBe(true);
    expect(v2!.preservationGate?.reason).toBe('abstention_gaming');
  });

  it('kill-switch off: same combo is accepted and runTrades is never called', async () => {
    const getRunTrades = vi.fn(async () => []);
    const runTrades = { getRunTrades, getBaselineRunTrades: vi.fn(async () => null) };
    const cap = capturingResearcher({ hypotheses: [], researchSummary: 's' });
    const services = makeServices({
      revisionRunExecutor: makeVetoExecutor(), researcher: cap.port, runTrades, preservationGateEnabled: false,
    });

    const baseBundle = await assembleStrategyBundle({ source: BASE_SOURCE, manifestMeta: BASE_MANIFEST_META });
    await seedAcceptedV1(services, baseBundle);
    await seedTwoHypotheses(services);

    await revisionBuildHandler(buildTask({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

    const revisions = await services.revisions.listByProfile('p1');
    const v2 = revisions.find((r) => r.version === 2);
    expect(v2).toBeDefined();
    expect(v2!.status).toBe('accepted');
    expect(getRunTrades).not.toHaveBeenCalled();
  });

  it('gate on but candidate aggregate-rejects: preservation never runs and runTrades is never called (lazy baseline fetch)', async () => {
    // Regression for the eager-fetch fix: with the gate enabled, a build whose candidate never
    // reaches an ACCEPT verdict must trigger NO trade fetch — the baseline fetch is lazy, gated on
    // a would-accept verdict — so a trades-read failure can't abort an aggregate-reject build.
    const getRunTrades = vi.fn(async () => []);
    const runTrades = { getRunTrades, getBaselineRunTrades: vi.fn(async () => null) };
    const cap = capturingResearcher({ hypotheses: [], researchSummary: 's' });
    const services = makeServices({ revisionRunExecutor: makeRejectExecutor(), researcher: cap.port, runTrades }); // gate ON (default)

    const baseBundle = await assembleStrategyBundle({ source: BASE_SOURCE, manifestMeta: BASE_MANIFEST_META });
    await seedAcceptedV1(services, baseBundle);
    await seedTwoHypotheses(services);

    await revisionBuildHandler(buildTask({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

    const revisions = await services.revisions.listByProfile('p1');
    const v2 = revisions.find((r) => r.version === 2);
    expect(v2).toBeDefined();
    expect(v2!.status).toBe('rejected');
    expect(getRunTrades).not.toHaveBeenCalled();
  });

  it('revision lane fail-open: a getRunTrades throw skips the veto and emits revision.preservation_skipped', async () => {
    // baseline runs (comparison_baseline) fine; the candidate variant fetch throws.
    const runTrades = {
      getRunTrades: vi.fn(async (id: string) => { if (id === 'cand-pr') throw new Error('boom'); return []; }),
      getBaselineRunTrades: vi.fn(async () => null),
    };
    const cap = capturingResearcher({ hypotheses: [], researchSummary: 's' });
    const services = makeServices({ revisionRunExecutor: makeVetoExecutor(), researcher: cap.port, runTrades });
    const events: string[] = [];
    const orig = services.events.append.bind(services.events);
    services.events.append = async (e: any) => { events.push(e.type); return orig(e); };

    const baseBundle = await assembleStrategyBundle({ source: BASE_SOURCE, manifestMeta: BASE_MANIFEST_META });
    await seedAcceptedV1(services, baseBundle);
    await seedTwoHypotheses(services);
    await revisionBuildHandler(buildTask({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

    // veto skipped → the combo's evaluateRevision ACCEPT stands → revision accepted
    const v2 = (await services.revisions.listByProfile('p1')).find((r) => r.version === 2);
    expect(v2?.status).toBe('accepted');
    expect(events).toContain('revision.preservation_skipped');
  });
});

// ---------------------------------------------------------------------------
// R1 Task 2: direct re-baseline of accepted revisions (W1 loop closure)
// ---------------------------------------------------------------------------
//
// `strategy.baseline` payloads carry no `payload` field on the QueueEnvelope itself (see
// task-intake.ts createAndEnqueueTask — the envelope is taskId/taskType/correlationId/source/
// attempt/dedupeKey only; payload lives on the persisted ResearchTask row). Assertions below
// query services.researchTasks.listByCorrelationAndTypes (the same lookup revisionBuildHandler
// itself uses for cycle-scoping) rather than the raw taskQueue envelopes.
describe('revision-flow integration (R1 Task 2): direct re-baseline of accepted revisions', () => {
  it('re-baselines an accepted revision directly when consolidation is off (W1)', async () => {
    const { executor } = makeFakeExecutor();
    const cap = capturingResearcher({ hypotheses: [], researchSummary: 's' });
    const services = makeServices({ revisionRunExecutor: executor, researcher: cap.port });

    const baseBundle = await assembleStrategyBundle({ source: BASE_SOURCE, manifestMeta: BASE_MANIFEST_META });
    await seedAcceptedV1(services, baseBundle);
    await seedTwoHypotheses(services);

    await revisionBuildHandler(buildTask({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

    const revisions = await services.revisions.listByProfile('p1');
    const v2 = revisions.find((r) => r.version === 2);
    expect(v2).toBeDefined();
    expect(v2!.status).toBe('accepted');

    const tasks = await services.researchTasks.listByCorrelationAndTypes('corr-1', ['strategy.baseline', 'revision.consolidate']);
    const baselineTasks = tasks.filter((t) => t.taskType === 'strategy.baseline');
    expect(baselineTasks).toHaveLength(1);
    expect(baselineTasks[0]).toMatchObject({
      dedupeKey: expect.stringMatching(/^strategy\.baseline:accepted:/),
      payload: expect.objectContaining({
        strategyProfileId: 'p1',
        revisionId: v2!.id,
        bundleArtifactRef: expect.anything(),
      }),
    });
    expect(tasks.filter((t) => t.taskType === 'revision.consolidate')).toHaveLength(0);

    // the accepted revision was marked pending for re-baseline:
    const accepted = await services.revisions.findLatestAccepted('p1');
    expect(accepted?.id).toBe(v2!.id);
    expect(accepted?.baselineValidationStatus).toBe('pending');
  });

  it('does NOT direct-rebaseline when consolidation fires (mutual exclusion)', async () => {
    const { executor } = makeFakeExecutor();
    const cap = capturingResearcher({ hypotheses: [], researchSummary: 's' });
    const services = makeServices({
      revisionRunExecutor: executor, researcher: cap.port,
      consolidator: new FakeStrategyConsolidator(), consolidationDepthThreshold: 1,
    });

    const baseBundle = await assembleStrategyBundle({ source: BASE_SOURCE, manifestMeta: BASE_MANIFEST_META });
    await seedAcceptedV1(services, baseBundle);
    await seedTwoHypotheses(services);

    await revisionBuildHandler(buildTask({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

    const revisions = await services.revisions.listByProfile('p1');
    const v2 = revisions.find((r) => r.version === 2);
    expect(v2).toBeDefined();
    expect(v2!.status).toBe('accepted');

    const tasks = await services.researchTasks.listByCorrelationAndTypes('corr-1', ['strategy.baseline', 'revision.consolidate']);
    expect(tasks.filter((t) => t.taskType === 'revision.consolidate')).toHaveLength(1);
    expect(tasks.filter((t) => t.taskType === 'strategy.baseline')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// R1 Task 4: revision.build Step-0 self-recheck / self-requeue (P0-1 / P0-2)
// ---------------------------------------------------------------------------
//
// The cycle-close trigger (enqueueCycleClose) is UNCONDITIONAL — the authoritative chain-terminality
// decision is made HERE, at revision.build execution, over settled statuses. When the chain is not
// yet terminal, Step-0 self-requeues a delayed revision.build (attempt-scoped dedupeKey, since the
// base key is already completed) up to CYCLE_CLOSE_MAX_WAIT_ATTEMPTS, then emits revision.build.abandoned.
// Terminality is driven purely by the researchTasks repo state (chain-type task rows / statuses).

/** Seeds a chain-type task row (hypothesis.build/backtest.completed/research.run_cycle) under corr-1. */
async function seedChainTask(services: AppServices, id: string, status: ResearchTask['status']): Promise<void> {
  await services.researchTasks.create({
    id, taskType: 'hypothesis.build', source: 'operator', correlationId: 'corr-1',
    status, payload: { hypothesisId: id }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  });
}

describe('revision-flow integration (R1 Task 4): revision.build Step-0 self-gate', () => {
  it('defers (delayed self-requeue + revision.build.deferred) when the chain is NOT terminal', async () => {
    const { executor, calls } = makeFakeExecutor();
    const cap = capturingResearcher({ hypotheses: [], researchSummary: 's' });
    const services = makeServices({ revisionRunExecutor: executor, researcher: cap.port });

    // one still-running chain member -> chain not terminal
    await seedChainTask(services, 'hb-running', 'running');

    await revisionBuildHandler(buildTask({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

    // no revision built (returned at Step-0)
    expect(await services.revisions.listByProfile('p1')).toHaveLength(0);
    // the executor was never touched
    expect(calls).toHaveLength(0);

    // a delayed revision.build was self-requeued with the attempt-scoped dedupeKey + waitAttempt:1
    const requeued = (await services.researchTasks.listByCorrelationAndTypes('corr-1', ['revision.build']))
      .filter((t) => /:wait1$/.test(t.dedupeKey ?? ''));
    expect(requeued).toHaveLength(1);
    expect(requeued[0]!.payload).toMatchObject({ strategyProfileId: 'p1', correlationId: 'corr-1', waitAttempt: 1 });

    const events = (await services.events.listByTask('task-rev-build')).map((e) => e.type);
    expect(events).toContain('revision.build.deferred');
    expect(events).not.toContain('revision.build.abandoned');
  });

  it('abandons (revision.build.abandoned, no re-enqueue, no revision) at the wait cap', async () => {
    const { executor, calls } = makeFakeExecutor();
    const cap = capturingResearcher({ hypotheses: [], researchSummary: 's' });
    const services = makeServices({ revisionRunExecutor: executor, researcher: cap.port });

    await seedChainTask(services, 'hb-running', 'running');

    // waitAttempt == cap -> abandon instead of re-queue
    await revisionBuildHandler(
      buildTask({ strategyProfileId: 'p1', correlationId: 'corr-1', waitAttempt: CYCLE_CLOSE_MAX_WAIT_ATTEMPTS }),
      services,
    );

    expect(await services.revisions.listByProfile('p1')).toHaveLength(0);
    expect(calls).toHaveLength(0);

    // no further self-requeue
    const requeued = (await services.researchTasks.listByCorrelationAndTypes('corr-1', ['revision.build']))
      .filter((t) => /:wait\d+$/.test(t.dedupeKey ?? ''));
    expect(requeued).toHaveLength(0);

    const events = (await services.events.listByTask('task-rev-build')).map((e) => e.type);
    expect(events).toContain('revision.build.abandoned');
    expect(events).not.toContain('revision.build.deferred');
  });

  it('builds as before when the chain IS terminal (all chain members settled)', async () => {
    const { executor } = makeFakeExecutor();
    const cap = capturingResearcher({ hypotheses: [], researchSummary: 's' });
    const services = makeServices({ revisionRunExecutor: executor, researcher: cap.port });

    const baseBundle = await assembleStrategyBundle({ source: BASE_SOURCE, manifestMeta: BASE_MANIFEST_META });
    await seedAcceptedV1(services, baseBundle);
    // seedTwoHypotheses seeds each hypothesis.build task row as 'completed' (terminal)
    await seedTwoHypotheses(services);

    await revisionBuildHandler(buildTask({ strategyProfileId: 'p1', correlationId: 'corr-1' }), services);

    const v2 = (await services.revisions.listByProfile('p1')).find((r) => r.version === 2);
    expect(v2).toBeDefined();
    expect(v2!.status).toBe('accepted');

    const events = (await services.events.listByTask('task-rev-build')).map((e) => e.type);
    expect(events).not.toContain('revision.build.deferred');
    expect(events).not.toContain('revision.build.abandoned');
  });
});
