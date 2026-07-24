// src/orchestrator/handlers/hypothesis-holdout.handler.test.ts
import { describe, it, expect } from 'vitest';
import { hypothesisHoldoutHandler } from './hypothesis-holdout.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import { hypothesisFamilyHint } from '../../research/hypothesis-family.ts';
import type { AppServices } from '../app-services.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';
import type { HypothesisBuild } from '../../domain/hypothesis-build.ts';
import type { BacktestRun } from '../../domain/backtest-run.ts';
import type { BacktestMetricBlock } from '../../ports/platform-gateway.port.ts';
import type { TradeRecord } from '../../domain/research-experiment.ts';
import type {
  ResearchPlatformPort, RunResultSummary, SubmitOverlayRunOptions, PlatformRunConfig,
} from '../../ports/research-platform.port.ts';

const NOW = '2026-01-01T00:00:00.000Z';

const PLATFORM_RUN: PlatformRunConfig = {
  datasetId: 'ds-1', symbols: ['BTCUSDT'], timeframe: '1h', seed: 7,
  period: { from: '2023-01-01T00:00:00.000Z', to: '2023-03-05T00:00:00.000Z' },
};

const IS_METRICS: BacktestMetricBlock = {
  netPnlUsd: 1000, netPnlPct: 10, totalTrades: 100, winRate: 0.6, profitFactor: 2.0,
  maxDrawdownPct: 5, expectancyUsd: 10, sharpe: 2.0, topTradeContributionPct: 20,
};

function metricRow(over: Partial<Record<string, number>> = {}): Record<string, number> {
  return {
    pnl: 500, max_drawdown: 0.04, win_rate: 0.55, sharpe: 1.5, total_trades: 60,
    top_trade_contribution_pct: 18, profit_factor: 1.8, ...over,
  };
}

/** A completed overlay RunResultSummary with a baseline-vs-variant comparison + optional trialContext. */
function summary(opts: { variantSharpe?: number; deflatedSharpe?: number } = {}): RunResultSummary {
  const variant = metricRow({ sharpe: opts.variantSharpe ?? 1.5 });
  return {
    runId: 'holdout-run', status: 'completed', runKind: 'baseline-vs-variant', validationIssues: [],
    metrics: metricRow(), coverage: [], artifactRefs: [],
    comparison: { baseline: metricRow(), variant, deltas: {} },
    evidence: { seed: 7, contractVersion: 'v1', moduleVersions: [] },
    ...(opts.deflatedSharpe !== undefined
      ? { trialContext: {
          familyKey: 'hypothesis:hyp-1', familyHint: 'hypothesis:hyp-1', trialCount: 3,
          deflatedSharpe: opts.deflatedSharpe, sr0: 0, vSR: 1, vSRBasis: 'asymptotic' as const, tCount: 100,
        } }
      : {}),
  };
}

function fakePlatform(cfg: {
  summary?: RunResultSummary;
  status?: RunResultSummary['status'];
  onSubmit?: (opts: SubmitOverlayRunOptions) => void;
  submitThrows?: boolean;
}): ResearchPlatformPort {
  const runStatus = cfg.status ?? 'completed';
  return {
    discover: async () => ({} as never),
    listDatasets: async () => ({ datasets: [] }),
    validateModule: async () => ({ status: 'accepted', issues: [], executed: false }),
    submitOverlayRun: async (_bundle, opts) => {
      if (cfg.submitThrows) throw new Error('submit boom');
      cfg.onSubmit?.(opts);
      return { jobId: 'j', runId: 'holdout-run', status: 'accepted', effectiveSeed: 7, requestFingerprint: 'fp', idempotentReplay: false };
    },
    submitStrategyResearchRun: async () => ({ jobId: 'j', runId: 'r', status: 'accepted', effectiveSeed: 7, requestFingerprint: 'fp', idempotentReplay: false }),
    getRunStatus: async () => ({ jobId: 'j', runId: 'holdout-run', status: runStatus, timeline: { acceptedAtMs: 0 } }),
    getRunResult: async () => ({ ok: true, kind: 'summary', summary: cfg.summary ?? summary() }),
  };
}

function hyp(id = 'hyp-1'): HypothesisProposal {
  return {
    id, strategyProfileId: 'profile-1', thesis: 't', targetBehavior: 'b',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'w', action: 'no_op', params: {} }] },
    requiredFeatures: ['oi'], validationPlan: 'p', expectedEffect: { metric: 'win_rate', direction: 'increase' },
    invalidationCriteria: ['x'], confidence: 0.5, status: 'validated', fingerprint: 'sha256:' + id,
    proposal: {} as never, issues: [], contractVersion: 'hypothesis-proposal-v1', createdAt: NOW, updatedAt: NOW,
  };
}

function makeTrades(n: number): TradeRecord[] {
  const base = Date.parse('2023-01-02T00:00:00.000Z');
  const span = Date.parse('2023-03-01T00:00:00.000Z') - base;
  return Array.from({ length: n }, (_, i) => {
    const entryTs = base + Math.floor((span * i) / n);
    return { entryTs, exitTs: entryTs + 3_600_000, side: 'long' as const, realizedPnl: 1 };
  });
}

function task(payload: Record<string, unknown>): ResearchTask {
  return {
    id: 'task-holdout', taskType: 'hypothesis.holdout', source: 'operator', correlationId: 'corr-1',
    status: 'running', payload, createdAt: NOW, updatedAt: NOW,
  };
}

const BASE_PAYLOAD = { hypothesisId: 'hyp-1', strategyProfileId: 'profile-1', backtestRunId: 'bt-run-1' };

/** Seed a PAPER_CANDIDATE backtest run + its build/bundle/hypothesis so the handler can run end-to-end. */
async function seed(s: AppServices, over: { metrics?: BacktestMetricBlock | null; withBundle?: boolean } = {}): Promise<void> {
  await s.hypotheses.create(hyp('hyp-1'));
  let bundleArtifactRef = null as HypothesisBuild['bundleArtifactRef'];
  if (over.withBundle !== false) {
    bundleArtifactRef = await s.artifacts.put(
      JSON.stringify({ manifest: { moduleId: 'm' }, files: {}, bundleHash: 'sha256:bh' }),
      { kind: 'module_bundle', mime_type: 'application/json', producer: 'test' },
    );
  }
  const build: HypothesisBuild = {
    id: 'build-1', hypothesisId: 'hyp-1', strategyProfileId: 'profile-1', status: 'candidate',
    builderAdapter: 'x', builderModel: 'y', bundleHash: 'sha256:bh', bundleArtifactRef, manifest: null,
    sdkContractVersion: 'v', bundleContractVersion: 'v', issues: [], attempt: 1, createdAt: NOW, updatedAt: NOW,
  };
  await s.builds.createGenerating(build);
  const run: BacktestRun = {
    id: 'bt-run-1', hypothesisBuildId: 'build-1', hypothesisId: 'hyp-1', strategyProfileId: 'profile-1',
    platformRunId: 'plat-1', correlationId: 'corr-1', params: {}, paramsHash: 'ph', bundleHash: 'sha256:bh',
    status: 'evaluated', baselineModuleId: 'strategy:profile-1', variantModuleId: 'm', backend: 'research_platform',
    taskId: 't', resumeToken: null, platformRun: PLATFORM_RUN,
    metrics: over.metrics === undefined ? IS_METRICS : over.metrics,
    baselineMetrics: null, deltaNetPnlUsd: 0, deltaMaxDrawdownPct: 0, isFragile: false, artifactRefs: [],
    platformContractVersion: 'v', sdkContractVersion: 'v', submittedAt: NOW, finishedAt: NOW, createdAt: NOW, updatedAt: NOW,
  };
  await s.backtests.createSubmitted(run);
}

const types = async (s: AppServices) => (await s.events.listByTask('task-holdout')).map((e) => e.type);

describe('hypothesisHoldoutHandler', () => {
  it('throws on invalid payload', async () => {
    const s = makeServices();
    await expect(hypothesisHoldoutHandler(task({ hypothesisId: '' }), s)).rejects.toThrow('invalid hypothesis.holdout payload');
  });

  // Requirement 3: IS baseline not recoverable → skipped (skip != fail), resolves successfully.
  it('skips is_baseline_unavailable when neither stored metrics nor isSharpe is present', async () => {
    const s = makeServices({ runTrades: { getRunTrades: async () => makeTrades(100), getBaselineRunTrades: async () => null } });
    await seed(s, { metrics: null });
    await expect(hypothesisHoldoutHandler(task(BASE_PAYLOAD), s)).resolves.toBeUndefined();
    const t = await types(s);
    expect(t).toContain('hypothesis.holdout.skipped');
    expect(t).not.toContain('hypothesis.holdout.completed');
    const skip = (await s.events.listByTask('task-holdout')).find((e) => e.type === 'hypothesis.holdout.skipped');
    expect(skip!.payload).toMatchObject({ reason: 'is_baseline_unavailable' });
  });

  // Requirement 3: submits exactly ONE single-fold run on the resolved [T, to] holdout window.
  it('submits one single-fold holdout run on the [T, to] window derived from the run trades', async () => {
    let calls = 0;
    let captured: SubmitOverlayRunOptions | undefined;
    const platform = fakePlatform({ summary: summary({ deflatedSharpe: 0.99 }), onSubmit: (o) => { calls += 1; captured = o; } });
    const s = makeServices({
      researchPlatform: platform,
      runTrades: { getRunTrades: async () => makeTrades(100), getBaselineRunTrades: async () => null },
    });
    await seed(s);
    await hypothesisHoldoutHandler(task(BASE_PAYLOAD), s);
    expect(calls).toBe(1);
    // The holdout window ends at the full period's end and starts strictly after its start (= T).
    expect(captured!.run.period.to).toBe(PLATFORM_RUN.period.to);
    expect(captured!.run.period.from).not.toBe(PLATFORM_RUN.period.from);
    expect(Date.parse(captured!.run.period.from)).toBeGreaterThan(Date.parse(PLATFORM_RUN.period.from));
  });

  // Requirement 7: the holdout submission carries the hypothesis family hint.
  it('threads trialFamilyHint onto the holdout submission', async () => {
    let captured: SubmitOverlayRunOptions | undefined;
    const platform = fakePlatform({ summary: summary({ deflatedSharpe: 0.99 }), onSubmit: (o) => { captured = o; } });
    const s = makeServices({
      researchPlatform: platform,
      runTrades: { getRunTrades: async () => makeTrades(100), getBaselineRunTrades: async () => null },
    });
    await seed(s);
    await hypothesisHoldoutHandler(task(BASE_PAYLOAD), s);
    expect(captured!.trialFamilyHint).toBe(hypothesisFamilyHint(hyp('hyp-1')));
    expect(captured!.trialFamilyHint).toBe('hypothesis:hyp-1');
  });

  // Requirement 4 (pass): completed run → battery pass → structural completed event + persisted report.
  it('runs the battery on completion, emits a structural completed event, and persists the full report', async () => {
    const platform = fakePlatform({ summary: summary({ variantSharpe: 1.5, deflatedSharpe: 0.99 }) });
    const s = makeServices({
      researchPlatform: platform,
      runTrades: { getRunTrades: async () => makeTrades(100), getBaselineRunTrades: async () => null },
    });
    await seed(s);
    await hypothesisHoldoutHandler(task(BASE_PAYLOAD), s);

    const completed = (await s.events.listByTask('task-holdout')).find((e) => e.type === 'hypothesis.holdout.completed');
    expect(completed).toBeDefined();
    // Structural only: outcome + failedReasonCodes, no observed magnitudes.
    expect(completed!.payload).toEqual({
      hypothesisId: 'hyp-1', backtestRunId: 'bt-run-1', outcome: 'pass', failedReasonCodes: [],
    });
    // Full report persisted on the hypothesis (persistence lane — magnitudes allowed here).
    const updated = await s.hypotheses.findById('hyp-1');
    expect(updated!.holdoutBattery).toBeDefined();
    expect(updated!.holdoutBattery!.outcome).toBe('pass');
    expect(updated!.holdoutBattery!.batteryVersion).toBe('break_battery@1');
  });

  // Requirement 4 (break): a low DSR breaks; plateau is omitted (skipped, never a break).
  it('reports break with canonical break_battery.* codes and never a plateau code', async () => {
    const platform = fakePlatform({ summary: summary({ deflatedSharpe: 0.5 }) });
    const s = makeServices({
      researchPlatform: platform,
      runTrades: { getRunTrades: async () => makeTrades(100), getBaselineRunTrades: async () => null },
    });
    await seed(s);
    await hypothesisHoldoutHandler(task(BASE_PAYLOAD), s);
    const completed = (await s.events.listByTask('task-holdout')).find((e) => e.type === 'hypothesis.holdout.completed');
    const codes = (completed!.payload as { failedReasonCodes: string[] }).failedReasonCodes;
    expect((completed!.payload as { outcome: string }).outcome).toBe('break');
    expect(codes).toContain('break_battery.dsr_below_floor');
    expect(codes).not.toContain('break_battery.lone_peak');
  });

  // Requirement 5: never mutates hypothesis status/verdict, never enqueues a retry.
  it('leaves the hypothesis status untouched and enqueues no follow-up task', async () => {
    const queue = makeServices().taskQueue;
    const platform = fakePlatform({ summary: summary({ deflatedSharpe: 0.5 }) });
    const s = makeServices({
      taskQueue: queue, researchPlatform: platform,
      runTrades: { getRunTrades: async () => makeTrades(100), getBaselineRunTrades: async () => null },
    });
    await seed(s);
    await hypothesisHoldoutHandler(task(BASE_PAYLOAD), s);
    const updated = await s.hypotheses.findById('hyp-1');
    expect(updated!.status).toBe('validated'); // unchanged — proxy status remains whatever it was
    expect((queue as unknown as { queued: unknown[] }).queued).toHaveLength(0);
  });

  // Requirement 6: submit throws → fail-soft diagnostic event, resolves, status untouched.
  it('is fail-soft when the holdout submit throws', async () => {
    const platform = fakePlatform({ submitThrows: true });
    const s = makeServices({
      researchPlatform: platform,
      runTrades: { getRunTrades: async () => makeTrades(100), getBaselineRunTrades: async () => null },
    });
    await seed(s);
    await expect(hypothesisHoldoutHandler(task(BASE_PAYLOAD), s)).resolves.toBeUndefined();
    const t = await types(s);
    expect(t).toContain('hypothesis.holdout.failed');
    expect(t).not.toContain('hypothesis.holdout.completed');
    const updated = await s.hypotheses.findById('hyp-1');
    expect(updated!.status).toBe('validated');
    expect(updated!.holdoutBattery).toBeUndefined();
  });

  // Requirement 6: a non-completed holdout run fails soft (holdout_run_pending), never a completed event.
  it('is fail-soft when the holdout run never terminates', async () => {
    const platform = fakePlatform({ status: 'running' });
    const s = makeServices({
      researchPlatform: platform,
      platformPoll: { maxPolls: 2, pollDelayMs: 0 },
      runTrades: { getRunTrades: async () => makeTrades(100), getBaselineRunTrades: async () => null },
    });
    await seed(s);
    await expect(hypothesisHoldoutHandler(task(BASE_PAYLOAD), s)).resolves.toBeUndefined();
    const failed = (await s.events.listByTask('task-holdout')).find((e) => e.type === 'hypothesis.holdout.failed');
    expect(failed!.payload).toMatchObject({ reason: 'holdout_run_pending' });
  });

  // Requirement 3: too few trades → no boundary → skipped holdout_window_unavailable.
  it('skips holdout_window_unavailable when the run has too few trades for a boundary', async () => {
    const s = makeServices({ runTrades: { getRunTrades: async () => makeTrades(3), getBaselineRunTrades: async () => null } });
    await seed(s);
    await hypothesisHoldoutHandler(task(BASE_PAYLOAD), s);
    const skip = (await s.events.listByTask('task-holdout')).find((e) => e.type === 'hypothesis.holdout.skipped');
    expect(skip!.payload).toMatchObject({ reason: 'holdout_window_unavailable' });
  });

  // Missing bundle artifact → skipped bundle_unavailable.
  it('skips bundle_unavailable when the build has no bundle artifact', async () => {
    const s = makeServices({ runTrades: { getRunTrades: async () => makeTrades(100), getBaselineRunTrades: async () => null } });
    await seed(s, { withBundle: false });
    await hypothesisHoldoutHandler(task(BASE_PAYLOAD), s);
    const skip = (await s.events.listByTask('task-holdout')).find((e) => e.type === 'hypothesis.holdout.skipped');
    expect(skip!.payload).toMatchObject({ reason: 'bundle_unavailable' });
  });
});
