/**
 * One-shot trigger: reconstruct the EXACT strategy bundle an EXISTING baseline experiment
 * validated and run `ExperimentService.runWalkForwardOptimization` (the 1-fold WFO decision
 * contour: GATE1 → LLM-designed sweep round(s) → ParamGridRunner → result-interpreter
 * select/extend/stop → one OOS holdout run → evaluateStrategyBaseline verdict) against a REAL
 * backtester. Prints `{ experimentId, verdict, terminalReason }` plus each member's
 * `{ role, oos, params, tradeCount, strategyBacktestRunId }`.
 *
 * The baseline experiment (`BASELINE_EXPERIMENT_ID`) must already exist and be a completed
 * `strategy_baseline_validation` experiment with a sanity/holdout member carrying a
 * `strategyBacktestRunId` with metrics — produced by scripts/run-strategy-baseline.mts. This
 * script does NOT re-run the baseline; it reads it (baseline metrics, holdout boundary source,
 * datasetScope) and starts the WFO round loop from there.
 *
 * BUNDLE RECONSTRUCTION: this script reconstructs the exact baseline bundle from
 * `research_experiment.bundle_artifact_ref` (persisted by run-strategy-baseline.mts) via
 * `reconstructStrategyBundle(services.artifacts, baseline.bundleArtifactRef)`
 * (src/research/reconstruct-strategy-bundle.ts) — it never rebuilds the bundle via the LLM
 * builder, so there is no bundle-hash mismatch to guard against. If the baseline row has no
 * `bundleArtifactRef` (e.g. it predates this script's ref-based version), this script throws an
 * actionable error naming the fix (re-run run-strategy-baseline.mts).
 *
 * Loads the strategy profile the SAME way as `BASELINE_EXPERIMENT_ID`'s baseline experiment:
 *   STRATEGY_PROFILE_ID env (if set) → services.strategyProfiles.findById(id)
 *   else → services.strategyProfiles.findById(baseline.strategyProfileId)
 *
 * Then: reconstructStrategyBundle(services.artifacts, baseline.bundleArtifactRef) →
 * services.experimentService.runWalkForwardOptimization({ baselineExperimentId, strategyBundle,
 * profile, strategyProfileId, datasetScope, runConfig, metrics, taskId, correlationId }) using
 * the baseline experiment's OWN datasetScope (datasetId / symbols / timeframe / period) plus
 * services.defaultPlatformRun.seed (the datasetScope persisted on a ResearchExperiment row
 * carries no `seed` field — mirrors run-strategy-baseline.mts's defaultPlatformRun-sourced
 * runConfig) and the RESEARCH_RUN_METRICS 7-metric catalog (038 catalog: pnl, sharpe,
 * max_drawdown, win_rate, total_trades, profit_factor, top_trade_contribution_pct —
 * src/domain/platform-comparison.ts). `correlationId` is set to the script's generated `taskId`
 * (`run-strategy-wfo-${randomUUID()}`), which doubles as the cumulative token-budget key for
 * this WFO run (ExperimentService.budgetExhausted).
 *
 * NOTE (tsc-invisible semantic contract): `datasetScope` carries `period`; `runConfig` is
 * `Omit<PlatformRunConfig, 'period'>` and must NOT carry it — the WFO round loop derives its own
 * train/holdout sub-periods from `runConfig` + a computed split point T (see
 * ExperimentService.runWalkForwardOptimization). Both shapes typecheck as plain object literals
 * either way; only the runtime split logic depends on `runConfig.period` being absent.
 *
 * runWalkForwardOptimization runs GATE1 (LLM), one or more sweep-designer (LLM) rounds each
 * followed by a ParamGridRunner sweep (multiple real backtester round trips, one per grid point),
 * a result-interpreter (LLM) decision per round, and — on 'select' — ONE final OOS holdout
 * backtest. Expect many round trips to the backtester, each polled per
 * PLATFORM_RUN_MAX_POLLS/PLATFORM_RUN_POLL_DELAY_MS.
 *
 * Run against a REAL backtester (not the in-process mock — this script THROWS if any selector
 * below is left at its silent default, so a misconfigured run fails fast instead of quietly
 * validating against the mock / fake agents / a template bundle):
 *   DATABASE_URL=postgres://...
 *   REDIS_URL=redis://...
 *   TRADING_PLATFORM_INTEGRATION=backtester   — REQUIRED. Selects HttpBacktesterAdapter for BOTH
 *                                                services.researchPlatform (submit) AND
 *                                                services.runTrades (getRunTrades) inside
 *                                                composeRuntime — see
 *                                                src/adapters/platform/select-research-platform.ts
 *                                                and select-run-trades.ts. Default ('mock')
 *                                                would run entirely in-process.
 *   BACKTESTER_API_URL     — real backtester HTTP endpoint (default: http://127.0.0.1:8080;
 *                              read directly from process.env by the two selectors above, NOT
 *                              from loadEnv()'s Env.BACKTESTER_API_URL).
 *   BACKTESTER_API_TOKEN   — optional bearer token for the backtester (default: '').
 *   PLATFORM_RUN_MAX_POLLS / PLATFORM_RUN_POLL_DELAY_MS — poll budget per platform run
 *                              (defaults 30 / 2000ms; loadEnv, src/config/env.ts).
 *   WFO_GATE1_ADAPTER=mastra              — REQUIRED. Otherwise composeRuntime wires FakeGate1
 *                              (rule-based) and this would not be a real GATE1 decision.
 *   WFO_SWEEP_DESIGNER_ADAPTER=mastra     — REQUIRED. Otherwise composeRuntime wires
 *                              FakeSweepDesigner (deterministic template grid).
 *   WFO_RESULT_INTERPRETER_ADAPTER=mastra — REQUIRED. Otherwise composeRuntime wires
 *                              FakeResultInterpreter (rule-based).
 *   MODEL_PROVIDER            — anthropic | openai | openrouter (validated below; loadEnv
 *                              silently defaults to 'anthropic' on garbage input). STILL REQUIRED
 *                              here even though this script no longer rebuilds the strategy
 *                              bundle: composeMastra(env) (src/mastra/compose-mastra.ts) builds
 *                              the three WFO agents (gate1/sweepDesigner/resultInterpreter)
 *                              eagerly inside composeRuntime() whenever their WFO_*_ADAPTER is
 *                              'mastra', via resolveLanguageModel(env, roleModelId)
 *                              (src/adapters/llm/model-provider.ts) — which falls back to
 *                              env.MODEL_PROVIDER for any WFO_*_MODEL value without an explicit
 *                              "anthropic/" | "openai/" | "openrouter/" prefix override. The
 *                              WFO_*_MODEL defaults below do carry an explicit "anthropic/"
 *                              prefix, so MODEL_PROVIDER is inert for an unconfigured run, but a
 *                              caller who overrides e.g. WFO_GATE1_MODEL to a bare model id
 *                              depends on it — kept validated so garbage input fails loudly
 *                              instead of loadEnv's silent 'anthropic' default.
 *   ANTHROPIC_API_KEY /
 *   OPENAI_API_KEY /
 *   OPENROUTER_API_KEY        — key matching the selected MODEL_PROVIDER (or a WFO_*_MODEL's
 *                              explicit prefix override); resolveLanguageModel throws if the
 *                              matching key is absent.
 *   WFO_GATE1_MODEL / WFO_SWEEP_DESIGNER_MODEL / WFO_RESULT_INTERPRETER_MODEL — model ids for the
 *                              three WFO agents (src/config/env.ts defaults).
 *   BASELINE_EXPERIMENT_ID     — REQUIRED. id of an existing completed strategy_baseline_validation
 *                              experiment (see scripts/run-strategy-baseline.mts).
 *   STRATEGY_PROFILE_ID        — optional; strategy_profile.id to load directly. If unset, the
 *                              script resolves it from the baseline experiment's
 *                              strategyProfileId.
 *   ENTRY_SIGNAL_EVIDENCE      — optional; set 'true' to pass entrySignalEvidence:true to GATE1
 *                              (evidence flag for a 0-trade baseline; defaults unset/false).
 *
 * Typecheck (file is OUTSIDE tsconfig include — manual invocation, mirrors
 * scripts/run-strategy-baseline.mts / scripts/seed-long-oi-profile.mts headers):
 *   npx tsc --noEmit --module nodenext --moduleResolution nodenext \
 *     --target es2022 --strict --allowImportingTsExtensions --skipLibCheck \
 *     scripts/run-strategy-wfo.mts
 */
import { randomUUID } from 'node:crypto';
import { composeRuntime } from '../src/composition.ts';
import { reconstructStrategyBundle } from '../src/research/reconstruct-strategy-bundle.ts';
import { RESEARCH_RUN_METRICS } from '../src/domain/platform-comparison.ts';
import { MODEL_PROVIDERS } from '../src/adapters/llm/model-provider.ts';
import type { DatasetScope } from '../src/domain/research-experiment.ts';
import type { PlatformRunConfig } from '../src/ports/research-platform.port.ts';

// ── env validation ────────────────────────────────────────────────────────────

const rawProvider = process.env['MODEL_PROVIDER'];
if (!rawProvider) {
  throw new Error('MODEL_PROVIDER env is required (anthropic | openai | openrouter)');
}
if (!(MODEL_PROVIDERS as readonly string[]).includes(rawProvider)) {
  throw new Error(
    `MODEL_PROVIDER="${rawProvider}" is not valid; expected one of: ${MODEL_PROVIDERS.join(' | ')}`,
  );
}

if (process.env['WFO_GATE1_ADAPTER'] !== 'mastra') {
  throw new Error(
    'WFO_GATE1_ADAPTER=mastra is required — otherwise composeRuntime wires FakeGate1 '
    + '(rule-based) and this would not be a real GATE1 decision.',
  );
}

if (process.env['WFO_SWEEP_DESIGNER_ADAPTER'] !== 'mastra') {
  throw new Error(
    'WFO_SWEEP_DESIGNER_ADAPTER=mastra is required — otherwise composeRuntime wires '
    + 'FakeSweepDesigner (a deterministic template grid) and this would not be a real sweep.',
  );
}

if (process.env['WFO_RESULT_INTERPRETER_ADAPTER'] !== 'mastra') {
  throw new Error(
    'WFO_RESULT_INTERPRETER_ADAPTER=mastra is required — otherwise composeRuntime wires '
    + 'FakeResultInterpreter (rule-based) and this would not be a real interpretation.',
  );
}

if (process.env['TRADING_PLATFORM_INTEGRATION'] !== 'backtester') {
  throw new Error(
    'TRADING_PLATFORM_INTEGRATION=backtester is required — otherwise composeRuntime wires the '
    + 'in-process mock research platform and this would not exercise a real backtester.',
  );
}

if (!process.env['DATABASE_URL']) throw new Error('DATABASE_URL env is required (composeRuntime persists here)');
if (!process.env['REDIS_URL']) throw new Error('REDIS_URL env is required (composeRuntime wires BullMQ unconditionally)');

const baselineExperimentId = process.env['BASELINE_EXPERIMENT_ID'];
if (!baselineExperimentId) {
  throw new Error('BASELINE_EXPERIMENT_ID env is required (id of an existing completed strategy_baseline_validation experiment)');
}

// ── compose the real runtime ──────────────────────────────────────────────────

const { services, pool, queue } = composeRuntime();

try {
  // ── 1) load the existing baseline experiment ────────────────────────────────

  const baseline = await services.experiments.findById(baselineExperimentId);
  if (!baseline) {
    throw new Error(`research_experiment id=${baselineExperimentId} (BASELINE_EXPERIMENT_ID) not found`);
  }
  process.stderr.write(
    `[run-wfo] baseline experiment id=${baseline.id} type=${baseline.experimentType} status=${baseline.status}\n`,
  );

  // ── 2) load the strategy profile (explicit STRATEGY_PROFILE_ID, else the baseline's own) ────

  const strategyProfileId = process.env['STRATEGY_PROFILE_ID'] ?? baseline.strategyProfileId;
  const profile = await services.strategyProfiles.findById(strategyProfileId);
  if (!profile) {
    throw new Error(`strategy_profile id=${strategyProfileId} not found`);
  }

  process.stderr.write(`[run-wfo] profile id=${profile.id} fingerprint=${profile.sourceFingerprint}\n`);

  // ── 3) reconstruct the EXACT strategy bundle the baseline validated ─────────────────────────
  //      (research_experiment.bundle_artifact_ref, persisted by run-strategy-baseline.mts) —
  //      no LLM rebuild, no bundle-hash mismatch possible.

  if (!baseline.bundleArtifactRef) {
    throw new Error(
      `baseline experiment ${baselineExperimentId} has no bundleArtifactRef — re-run `
      + 'scripts/run-strategy-baseline.mts (post-G1 version) to persist the bundle ref.',
    );
  }
  const strategyBundle = await reconstructStrategyBundle(services.artifacts, baseline.bundleArtifactRef);
  process.stderr.write(
    `[run-wfo] reconstructed bundle id=${strategyBundle.manifest.id} hash=${strategyBundle.bundleHash}\n`,
  );

  // ── 4) run the WFO decision contour against the real backtester ────────────────

  const datasetScope: DatasetScope = {
    datasetId: baseline.datasetScope.datasetId,
    symbols: baseline.datasetScope.symbols,
    timeframe: baseline.datasetScope.timeframe,
    period: baseline.datasetScope.period,
  };
  const runConfig: Omit<PlatformRunConfig, 'period'> = {
    datasetId: baseline.datasetScope.datasetId,
    symbols: baseline.datasetScope.symbols,
    timeframe: baseline.datasetScope.timeframe,
    seed: services.defaultPlatformRun.seed,
  };
  const taskId = `run-strategy-wfo-${randomUUID()}`;
  const entrySignalEvidence = process.env['ENTRY_SIGNAL_EVIDENCE'] === 'true' ? true : undefined;

  process.stderr.write(
    `[run-wfo] runWalkForwardOptimization baselineExperimentId=${baselineExperimentId} `
    + `dataset=${datasetScope.datasetId} period=${datasetScope.period.from}..${datasetScope.period.to} `
    + `taskId=${taskId}...\n`,
  );

  const { experimentId, verdict, terminalReason } = await services.experimentService.runWalkForwardOptimization({
    baselineExperimentId,
    strategyBundle,
    profile,
    strategyProfileId,
    datasetScope,
    runConfig,
    metrics: RESEARCH_RUN_METRICS,
    taskId,
    correlationId: taskId,
    ...(entrySignalEvidence !== undefined ? { entrySignalEvidence } : {}),
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ experimentId, verdict, terminalReason }));

  // ── 5) read back member ledger rows ─────────────────────────────────────────

  const members = await services.experiments.listMembers(experimentId);
  for (const m of members) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      role: m.role,
      oos: m.oos ?? null,
      params: m.params ?? null,
      tradeCount: m.tradeCount ?? null,
      strategyBacktestRunId: m.strategyBacktestRunId ?? null,
    }));
  }
} finally {
  await queue.close();
  await pool.end();
}
