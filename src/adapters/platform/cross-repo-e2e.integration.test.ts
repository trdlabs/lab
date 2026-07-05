/**
 * Feature 5 — cross-repo E2E integration gate (opt-in).
 *
 * Proves the three-system path:
 *   trading-lab → trading-backtester → trading-mock-platform (historical data)
 *
 * Prerequisites (demo stack):
 *   docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo up --build
 *
 * Run (demo stack up):
 *   make cross-repo-e2e MODE=demo
 * Or manually:
 *   RUN_CROSS_REPO_E2E=true BACKTESTER_API_URL=http://127.0.0.1:8081 BACKTESTER_API_TOKEN=demo-backtester-token \
 *     pnpm vitest run src/adapters/platform/cross-repo-e2e.integration.test.ts
 *
 * Gating: skips unless RUN_CROSS_REPO_E2E=true and BACKTESTER_API_URL are set.
 * The backtester must be configured with BACKTESTER_DATA_SOURCE=mock (demo overlay default).
 */

import { describe, it, expect } from 'vitest';
import { BacktesterClient } from '@trading-backtester/sdk/client';
import type { ModuleBundle } from '../../domain/module-bundle.ts';
import { SDK_CONTRACT_VERSION } from '../../domain/module-bundle.ts';
import { HttpBacktesterAdapter, HttpBacktesterRunTradesAdapter } from './http-backtester.adapter.ts';
import { hypothesisBuildHandler } from '../../orchestrator/handlers/hypothesis-build.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import type { BuilderInput, BuilderOutput, BuilderPort } from '../../ports/builder.port.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { PlatformRunConfig } from '../../ports/research-platform.port.ts';
import { ExperimentService } from '../../research/experiment-service.ts';
import { BacktesterExperimentRunExecutor } from '../../research/backtester-experiment-run-executor.ts';
import { InMemoryResearchExperimentRepository } from '../../adapters/repository/in-memory-research-experiment.repository.ts';
import { InMemoryBacktestRunRepository } from '../../adapters/repository/in-memory-backtest-run.repository.ts';
import { InMemoryStrategyBacktestRunRepository } from '../../adapters/repository/in-memory-strategy-backtest-run.repository.ts';
import { InMemoryAgentEventRepository } from '../../adapters/repository/in-memory-agent-event.repository.ts';
import { FakeGate1 } from '../../adapters/wfo/fake-gate1.ts';
import { FakeSweepDesigner } from '../../adapters/wfo/fake-sweep-designer.ts';
import { FakeResultInterpreter } from '../../adapters/wfo/fake-result-interpreter.ts';
import { ParamGridRunner } from '../../research/param-grid-runner.ts';
import { DEFAULT_EVALUATOR_THRESHOLDS } from '../../validation/evaluator.ts';

const enabled =
  process.env.RUN_CROSS_REPO_E2E === 'true' && !!process.env.BACKTESTER_API_URL;

const TERMINAL = new Set(['completed', 'failed', 'canceled', 'expired', 'timed_out']);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A minimal but VALID submitted overlay bundle: default export with the single `apply` hook the
 *  sandbox harness invokes. Pass-through (no patch) — enough to drive a real baseline-vs-variant run. */
const strategyBundle: ModuleBundle = {
  manifest: {
    moduleId: 'lab_overlay_probe',
    moduleKind: 'hypothesis_overlay',
    appliesTo: 'long',
    entry: 'module.mjs',
    exports: ['apply'],
    capabilities: [],
    sdkContractVersion: SDK_CONTRACT_VERSION,
  },
  files: {
    'module.mjs': 'export default { apply(_ctx){ return { kind: "pass" }; } };',
  },
  bundleHash: 'sha256:integration',
  bundleContractVersion: 'module-bundle-v1',
};

/** Builder stub that emits the integration strategy bundle (no LLM / network). */
class IntegrationTestBuilder implements BuilderPort {
  readonly adapter = 'integration' as const;
  readonly model = 'integration';

  async build(_input: BuilderInput): Promise<BuilderOutput> {
    return {
      manifest: strategyBundle.manifest,
      files: strategyBundle.files,
      notes: 'cross-repo e2e integration template',
    };
  }
}

function client(): BacktesterClient {
  return new BacktesterClient({
    baseUrl: process.env.BACKTESTER_API_URL as string,
    token: process.env.BACKTESTER_API_TOKEN ?? '',
  });
}

function adapter(): HttpBacktesterAdapter {
  return new HttpBacktesterAdapter(client());
}

async function pollToTerminal(
  a: HttpBacktesterAdapter,
  runId: string,
  maxPolls = 120,
  delayMs = 500,
): Promise<string> {
  let view = await a.getRunStatus(runId);
  for (let i = 0; i < maxPolls && !TERMINAL.has(view.status); i += 1) {
    await sleep(delayMs);
    view = await a.getRunStatus(runId);
  }
  return view.status;
}

/** Mock-platform datasets use `SYMBOL:timeframe` refs; fixture mode uses names like `smoke-btc-1m`. */
function isMockPlatformDatasetRef(ref: string): boolean {
  const colon = ref.indexOf(':');
  return colon > 0 && colon < ref.length - 1;
}

function profile(): StrategyProfile {
  const now = '2026-01-01T00:00:00Z';
  return {
    id: 'p1',
    version: 1,
    sourceKind: 'manual_description',
    sourceFingerprint: 'sha256:s',
    direction: 'long',
    coreIdea: 'momentum filter',
    requiredMarketFeatures: ['oi'],
    confidence: 0.6,
    unknowns: [],
    profile: {} as never,
    sourceArtifactRef: {} as never,
    contractVersion: 'strategy-profile-v1',
    createdAt: now,
    updatedAt: now,
  };
}

function hypothesis(): HypothesisProposal {
  const now = '2026-01-01T00:00:00Z';
  return {
    id: 'h1',
    strategyProfileId: 'p1',
    thesis: 'Skip entries without momentum',
    targetBehavior: 'filter entries',
    ruleAction: {
      appliesTo: 'long',
      rules: [{ when: 'no momentum', action: 'skip_entry', params: { bars: 2 } }],
    },
    requiredFeatures: ['oi'],
    validationPlan: 'backtest 90d',
    expectedEffect: { metric: 'win_rate', direction: 'increase' },
    invalidationCriteria: ['no improvement'],
    confidence: 0.5,
    status: 'validated',
    fingerprint: 'sha256:cross-repo-e2e',
    proposal: {} as never,
    issues: [],
    contractVersion: 'hypothesis-proposal-v1',
    createdAt: now,
    updatedAt: now,
  };
}

function task(platformRun: PlatformRunConfig): ResearchTask {
  const now = '2026-01-01T00:00:00Z';
  return {
    id: 't-cross-repo',
    taskType: 'hypothesis.build',
    source: 'operator',
    correlationId: 'cross-repo-e2e',
    status: 'running',
    payload: { hypothesisId: 'h1', platformRun },
    createdAt: now,
    updatedAt: now,
  };
}

describe.skipIf(!enabled)('cross-repo E2E (lab → backtester → mock-platform)', () => {
  it('backtester listDatasets exposes mock-platform symbol:timeframe refs', async () => {
    const datasets = await client().listDatasets();
    expect(datasets.length).toBeGreaterThan(0);
    const mockRefs = datasets.filter((d) => isMockPlatformDatasetRef(d.datasetRef));
    expect(mockRefs.length).toBeGreaterThan(0);
    // Fixture-only backtester would expose smoke-btc-1m style refs — this proves the mock data path.
    expect(datasets.every((d) => !d.datasetRef.startsWith('smoke-'))).toBe(true);
  }, 30_000);

  it('HttpBacktesterAdapter submits against a discovered mock-platform dataset and completes', async () => {
    const a = adapter();
    const { datasets } = await a.listDatasets();
    expect(datasets.length).toBeGreaterThan(0);
    const pick = datasets.find((d) => isMockPlatformDatasetRef(d.datasetId)) ?? datasets[0]!;

    const handle = await a.submitOverlayRun(strategyBundle, {
      target: { kind: 'registry_preset' },
      run: {
        datasetId: pick.datasetId,
        symbols: pick.symbols,
        timeframe: pick.timeframe,
        period: pick.dateRange,
        seed: 42,
      },
    });

    const status = await pollToTerminal(a, handle.runId);
    expect(status).toBe('completed');

    const result = await a.getRunResult(handle.runId);
    expect(result.kind).toBe('summary');
    if (result.kind === 'summary') {
      // Preset-driven overlay run → a real baseline-vs-variant comparison (the epic's payoff).
      expect(result.summary.runKind).toBe('baseline-vs-variant');
      expect(result.summary.comparison).toBeDefined();
      expect(Object.keys(result.summary.metrics).length).toBeGreaterThan(0);
    }
  }, 120_000);

  it('hypothesis.build handler drives the full lab→backtester→mock-platform flow through holdout validation to a verdict', async () => {
    const a = adapter();
    const { datasets } = await a.listDatasets();
    const pick = datasets.find((d) => isMockPlatformDatasetRef(d.datasetId)) ?? datasets[0]!;
    const platformRun: PlatformRunConfig = {
      datasetId: pick.datasetId,
      symbols: [...pick.symbols],
      timeframe: pick.timeframe,
      period: pick.dateRange,
      seed: 42,
    };

    // 98852d9 (holdout validation, 2026-07-01) rerouted hypothesis.build's cycleDepth===0 branch away
    // from the single-backtest path (services.backtests / services.evaluations) into
    // services.experimentService.runNewStrategyValidation, which drives sanity → train → holdout
    // members and records the outcome in services.experiments (+ an `experiment.completed` event)
    // instead. makeServices()'s default experimentService is wired with an in-memory fake runExecutor,
    // so to keep this test honestly proving the real cross-repo chain we wire the SAME
    // BacktesterExperimentRunExecutor / HttpBacktesterRunTradesAdapter production composition (see
    // src/composition.ts) against the live backtester + mock-platform stack.
    const experiments = new InMemoryResearchExperimentRepository();
    const events = new InMemoryAgentEventRepository();
    const backtests = new InMemoryBacktestRunRepository();
    let idCounter = 0;
    const strategyRunExecutor = {
      execute: async () => {
        throw new Error('strategyRunExecutor must not be called from runNewStrategyValidation');
      },
    };
    const experimentService = new ExperimentService({
      experiments,
      runTrades: new HttpBacktesterRunTradesAdapter(client()),
      runExecutor: new BacktesterExperimentRunExecutor({
        platform: a,
        backtests,
        researchIntegration: 'backtester',
        fragilityTopTradePct: DEFAULT_EVALUATOR_THRESHOLDS.fragilityTopTradePct,
        poll: { maxPolls: 120, pollDelayMs: 500 },
        now: () => new Date().toISOString(),
      }),
      strategyRunExecutor,
      newId: (p) => `${p}-${++idCounter}`,
      now: () => new Date().toISOString(),
      events,
      gate1: new FakeGate1(),
      sweepDesigner: new FakeSweepDesigner(),
      resultInterpreter: new FakeResultInterpreter(),
      paramGridRunner: new ParamGridRunner({ strategyRunExecutor }),
      strategyBacktests: new InMemoryStrategyBacktestRunRepository(),
    });

    const s = makeServices({
      researchPlatform: a,
      researchIntegration: 'backtester',
      builder: new IntegrationTestBuilder(),
      platformPoll: { maxPolls: 120, pollDelayMs: 500 },
      events,
      experiments,
      experimentService,
    });
    await s.strategyProfiles.create(profile());
    await s.hypotheses.create(hypothesis());

    const t = task(platformRun);
    await hypothesisBuildHandler(t, s);

    // The handler never touches backtests/evaluations on the cycleDepth===0 (holdout) branch anymore —
    // assert against the experiment registry the holdout contour actually writes to.
    const exps = await experiments.listByType('new_strategy_validation');
    expect(exps).toHaveLength(1);
    const exp = exps[0]!;
    expect(exp.hypothesisId).toBe('h1');
    expect(exp.status).toBe('completed');
    expect(['PASS', 'FAIL', 'MODIFY', 'INCONCLUSIVE', 'PAPER_CANDIDATE']).toContain(exp.verdict);

    // At least the sanity member ran for real against the live backtester (real backtestRunId, real
    // reported trade count) — proof the holdout contour reached the backtester+mock-platform, not a
    // stub. The mock-platform synthetic fixture only spans a few days per dataset, so the registry
    // preset legitimately closes zero trades here and the experiment fails fast on `sanity_failed`
    // (see resolveHoldoutBoundary's minHistoryDays gate for why it would be inconclusive even if the
    // preset did trade) — that is still a real, non-fabricated round trip through the real chain.
    const members = await experiments.listMembers(exp.id);
    expect(members.length).toBeGreaterThan(0);
    const sanityMember = members.find((m) => m.role === 'sanity');
    expect(sanityMember?.backtestRunId).toBeTruthy();
    expect(sanityMember?.tradeCount).toBeTypeOf('number');

    const taskEvents = await events.listByTask(t.id);
    const memberCompletedEvents = taskEvents.filter((e) => e.type === 'experiment.member.completed');
    const sanityEvent = memberCompletedEvents.find((e) => (e.payload as { role?: string }).role === 'sanity');
    expect((sanityEvent?.payload as { status?: string } | undefined)?.status).toBe('completed');

    const completedEvent = taskEvents.find((e) => e.type === 'experiment.completed');
    expect(completedEvent).toBeDefined();
    expect(completedEvent?.payload).toMatchObject({ experimentId: exp.id, verdict: exp.verdict });
  }, 180_000);
});
