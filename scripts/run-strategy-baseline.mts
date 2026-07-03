/**
 * One-shot trigger: build the long_oi STRATEGY bundle from the seeded profile
 * (scripts/seed-long-oi-profile.mts) and run `ExperimentService.runStrategyBaselineValidation`
 * against a REAL backtester. Prints `{ experimentId, verdict }` plus each member's
 * `{ role, tradeCount, strategyBacktestRunId }` (the T16 acceptance signal: sanity
 * `totalTrades > 0`), and the sanity member's raw metrics when available.
 *
 * Loads the profile the SAME way scripts/seed-long-oi-profile.mts persisted it:
 *   STRATEGY_PROFILE_ID env (if set) → services.strategyProfiles.findById(id)
 *   else → findByFingerprint(sourceFingerprint('bot_code', buildCodeSource(readCodeDir(longOiDir))))
 *   (same vendored code dir as the seed script — run that script FIRST if this throws
 *   "no strategy_profile for fingerprint=...").
 *
 * Then: services.strategyBuilder.build({ spec, authoringDoc, profile }) → assembleStrategyBundle
 * → services.artifacts.put(...) (audit anchor, same shape as authorStrategyBundleHandler's
 * 'strategy_bundle' persist) → services.experimentService.runStrategyBaselineValidation({
 * strategyProfileId, strategyBundle, datasetScope, runConfig, metrics, taskId, bundleArtifactRef })
 * using composeRuntime()'s services.defaultPlatformRun (ESPORTSUSDT:1h, 2026-06-12..19, seed 42 —
 * src/composition.ts) and the RESEARCH_RUN_METRICS 7-metric catalog (038 catalog:
 * pnl, sharpe, max_drawdown, win_rate, total_trades, profit_factor, top_trade_contribution_pct —
 * src/domain/platform-comparison.ts; the SDK's own METRIC_CATALOG is not publicly exported).
 * The `bundleArtifactRef` returned by services.artifacts.put(...) is persisted on the
 * research_experiment row (ResearchExperiment.bundleArtifactRef) so a later WFO run can
 * reconstruct this EXACT bundle via src/research/reconstruct-strategy-bundle.ts instead of
 * rebuilding it via the LLM builder (see scripts/run-strategy-wfo.mts).
 *
 * runStrategyBaselineValidation runs THREE platform backtests (sanity over the full period,
 * then train/holdout split from the sanity run's real trades) — expect multiple round trips to
 * the backtester, each polled per PLATFORM_RUN_MAX_POLLS/PLATFORM_RUN_POLL_DELAY_MS.
 *
 * Run against a REAL backtester (not the in-process mock — this script THROWS if either
 * selector below is left at its silent default, so a misconfigured run fails fast instead of
 * quietly validating against the mock / a template bundle):
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
 *   BUILDER_ADAPTER=mastra   — REQUIRED. composeRuntime's buildStrategyBuilder() silently falls
 *                              back to FakeStrategyBuilder (a template bundle, not a real LLM
 *                              build) for any other value.
 *   MODEL_PROVIDER            — anthropic | openai | openrouter (validated below; loadEnv
 *                              silently defaults to 'anthropic' on garbage input).
 *   ANTHROPIC_API_KEY /
 *   OPENAI_API_KEY /
 *   OPENROUTER_API_KEY        — key matching the selected MODEL_PROVIDER.
 *   BUILDER_MODEL              — model id for the strategy builder
 *                              (default: anthropic/claude-sonnet-4-6 — src/config/env.ts).
 *   STRATEGY_PROFILE_ID        — optional; strategy_profile.id to load directly. If unset, the
 *                              script falls back to the fingerprint lookup below (run
 *                              scripts/seed-long-oi-profile.mts first to persist it).
 *   LONGOI_CODE_DIR            — override the vendored long_oi code dir (default: below; only
 *                              read for the STRATEGY_PROFILE_ID-unset fingerprint fallback).
 *
 * Vendored code dir (fingerprint fallback only, must match scripts/seed-long-oi-profile.mts):
 *   docs/fixtures/strategies/long-oi-code/
 *
 * Typecheck (file is OUTSIDE tsconfig include — manual invocation, mirrors
 * scripts/seed-long-oi-profile.mts / scripts/code-analyst-roundtrip.mts headers):
 *   npx tsc --noEmit --module nodenext --moduleResolution nodenext \
 *     --target es2022 --strict --allowImportingTsExtensions --skipLibCheck \
 *     scripts/run-strategy-baseline.mts
 */
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCodeDir } from '../src/adapters/code-source/read-code-dir.ts';
import { buildCodeSource } from '../src/domain/code-source.ts';
import { composeRuntime } from '../src/composition.ts';
import { sourceFingerprint } from '../src/domain/fingerprint.ts';
import { assembleStrategyBundle } from '../src/domain/strategy-bundle.ts';
import { RESEARCH_RUN_METRICS } from '../src/domain/platform-comparison.ts';
import { MODEL_PROVIDERS } from '../src/adapters/llm/model-provider.ts';
import { getAuthoringDoc } from '@trading-backtester/sdk/builder';
import type { DatasetScope } from '../src/domain/research-experiment.ts';
import type { PlatformRunConfig } from '../src/ports/research-platform.port.ts';

// ── env validation ────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const longOiDir = process.env['LONGOI_CODE_DIR']
  ?? resolve(__dirname, '../docs/fixtures/strategies/long-oi-code');

const rawProvider = process.env['MODEL_PROVIDER'];
if (!rawProvider) {
  throw new Error('MODEL_PROVIDER env is required (anthropic | openai | openrouter)');
}
if (!(MODEL_PROVIDERS as readonly string[]).includes(rawProvider)) {
  throw new Error(
    `MODEL_PROVIDER="${rawProvider}" is not valid; expected one of: ${MODEL_PROVIDERS.join(' | ')}`,
  );
}

if (process.env['BUILDER_ADAPTER'] !== 'mastra') {
  throw new Error(
    'BUILDER_ADAPTER=mastra is required — otherwise composeRuntime wires FakeStrategyBuilder '
    + '(a template bundle) and this would not be a real build.',
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

// ── compose the real runtime ──────────────────────────────────────────────────

const { services, pool, queue } = composeRuntime();

try {
  // ── 1) load the seeded profile (by id, or by the same fingerprint the seed script used) ────

  const profileId = process.env['STRATEGY_PROFILE_ID'];
  const profile = profileId
    ? await services.strategyProfiles.findById(profileId)
    : await (async () => {
      const files = readCodeDir(longOiDir);
      const content = buildCodeSource(files);
      const fingerprint = sourceFingerprint('bot_code', content);
      return services.strategyProfiles.findByFingerprint(fingerprint);
    })();

  if (!profile) {
    throw new Error(
      profileId
        ? `strategy_profile id=${profileId} (STRATEGY_PROFILE_ID) not found`
        : `no strategy_profile found by fingerprint for code=${longOiDir} — `
          + 'run scripts/seed-long-oi-profile.mts first (or set STRATEGY_PROFILE_ID).',
    );
  }

  process.stderr.write(`[run-baseline] profile id=${profile.id} fingerprint=${profile.sourceFingerprint}\n`);

  // ── 2) build the strategy bundle via the composed builder (real LLM; BUILDER_ADAPTER=mastra) ──

  const authoringDoc = getAuthoringDoc('strategy');
  process.stderr.write(
    `[run-baseline] strategyBuilder.build() adapter=${services.strategyBuilder.adapter} `
    + `model=${services.strategyBuilder.model}...\n`,
  );
  const out = await services.strategyBuilder.build({
    spec: { description: 'long oi baseline' },
    authoringDoc,
    profile,
  });
  const strategyBundle = await assembleStrategyBundle(out);
  process.stderr.write(
    `[run-baseline] bundle id=${strategyBundle.manifest.id} hash=${strategyBundle.bundleHash}\n`,
  );

  // ── 3) persist the bundle before submit (audit anchor; same shape as
  //      authorStrategyBundleHandler's 'strategy_bundle' persist) — the returned ref is passed
  //      into runStrategyBaselineValidation below so it lands on the research_experiment row,
  //      letting scripts/run-strategy-wfo.mts reconstruct this EXACT bundle later ────────────

  const bundleArtifactRef = await services.artifacts.put(
    JSON.stringify({
      source: strategyBundle.source,
      manifest: strategyBundle.manifest,
      bundleHash: strategyBundle.bundleHash,
    }),
    { kind: 'strategy_bundle', mime_type: 'application/json', producer: 'run-strategy-baseline' },
  );

  // ── 4) run the baseline validation experiment against the real backtester ──────

  const defaultRun = services.defaultPlatformRun;
  const datasetScope: DatasetScope = {
    datasetId: defaultRun.datasetId,
    symbols: defaultRun.symbols,
    timeframe: defaultRun.timeframe,
    period: defaultRun.period,
  };
  const runConfig: Omit<PlatformRunConfig, 'period'> = {
    datasetId: defaultRun.datasetId,
    symbols: defaultRun.symbols,
    timeframe: defaultRun.timeframe,
    seed: defaultRun.seed,
  };
  const taskId = `run-strategy-baseline-${randomUUID()}`;

  process.stderr.write(
    `[run-baseline] runStrategyBaselineValidation dataset=${datasetScope.datasetId} `
    + `period=${datasetScope.period.from}..${datasetScope.period.to} taskId=${taskId}...\n`,
  );

  const { experimentId, verdict } = await services.experimentService.runStrategyBaselineValidation({
    strategyProfileId: profile.id,
    strategyBundle,
    datasetScope,
    runConfig,
    metrics: RESEARCH_RUN_METRICS,
    taskId,
    bundleArtifactRef,
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ experimentId, verdict }));

  // ── 5) read back member trade counts (T16 acceptance signal: sanity totalTrades > 0) ────

  const members = await services.experiments.listMembers(experimentId);
  for (const m of members) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      role: m.role,
      tradeCount: m.tradeCount ?? null,
      strategyBacktestRunId: m.strategyBacktestRunId ?? null,
    }));
  }

  const sanity = members.find((m) => m.role === 'sanity');
  if (sanity?.strategyBacktestRunId) {
    const run = await services.strategyBacktests.findById(sanity.strategyBacktestRunId);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ sanityMetrics: run?.metrics ?? null }));
  }
} finally {
  await queue.close();
  await pool.end();
}
