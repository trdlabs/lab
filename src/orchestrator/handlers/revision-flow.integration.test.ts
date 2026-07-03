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
import { describe, it, expect } from 'vitest';
import { revisionBuildHandler } from './revision-build.handler.ts';
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
