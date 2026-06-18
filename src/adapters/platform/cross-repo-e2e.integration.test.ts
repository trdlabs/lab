/**
 * Feature 5 — cross-repo E2E integration gate (opt-in).
 *
 * Proves the three-system path:
 *   trading-lab → trading-backtester → trading-mock-platform (historical data)
 *
 * Prerequisites (demo stack):
 *   docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo up --build
 *
 * Run:
 *   RUN_CROSS_REPO_E2E=true BACKTESTER_API_URL=http://127.0.0.1:8080 BACKTESTER_API_TOKEN=demo-backtester-token \
 *     pnpm vitest run src/adapters/platform/cross-repo-e2e.integration.test.ts
 *
 * Gating: skips unless RUN_CROSS_REPO_E2E=true and BACKTESTER_API_URL are set.
 * The backtester must be configured with BACKTESTER_DATA_SOURCE=mock (demo overlay default).
 */

import { describe, it, expect } from 'vitest';
import { BacktesterClient } from '@trading-backtester/client';
import type { ModuleBundle } from '../../domain/module-bundle.ts';
import { SDK_CONTRACT_VERSION } from '../../domain/module-bundle.ts';
import { HttpBacktesterAdapter } from './http-backtester.adapter.ts';
import { hypothesisBuildHandler } from '../../orchestrator/handlers/hypothesis-build.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import type { BuilderInput, BuilderOutput, BuilderPort } from '../../ports/builder.port.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { PlatformRunConfig } from '../../ports/research-platform.port.ts';

const enabled =
  process.env.RUN_CROSS_REPO_E2E === 'true' && !!process.env.BACKTESTER_API_URL;

const TERMINAL = new Set(['completed', 'failed', 'canceled', 'expired', 'timed_out']);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Strategy-signals bundle the backtester executes today (same as http-backtester.integration.test.ts). */
const strategyBundle: ModuleBundle = {
  manifest: {
    moduleId: 'momentum',
    moduleKind: 'hypothesis_overlay',
    appliesTo: 'long',
    entry: 'module.mjs',
    exports: ['signals'],
    capabilities: [],
    sdkContractVersion: SDK_CONTRACT_VERSION,
  },
  files: {
    'module.mjs':
      'export function signals(candles){ return candles.map((_,i)=> i>=2 && candles[i-1].close>candles[i-2].close); }',
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
      baselineModuleRef: { id: 'baseline', version: 'v1' },
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
      expect(result.summary.metrics.total_bars).toBeGreaterThan(0);
    }
  }, 120_000);

  it('hypothesis.build handler drives the full lab→backtester→mock-platform flow to evaluated', async () => {
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

    const s = makeServices({
      researchPlatform: a,
      builder: new IntegrationTestBuilder(),
      platformPoll: { maxPolls: 120, pollDelayMs: 500 },
    });
    await s.strategyProfiles.create(profile());
    await s.hypotheses.create(hypothesis());

    await hypothesisBuildHandler(task(platformRun), s);

    const runs = await s.backtests.listByHypothesis('h1');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('evaluated');
    expect(runs[0]?.backend).toBe('research_platform');
    expect(runs[0]?.metrics?.netPnlUsd).toBeTypeOf('number');

    const evals = await s.evaluations.listByBacktestRun(runs[0]!.id);
    expect(evals).toHaveLength(1);
    expect(['PASS', 'FAIL', 'MODIFY', 'INCONCLUSIVE', 'PAPER_CANDIDATE']).toContain(evals[0]?.decision);
  }, 180_000);
});
