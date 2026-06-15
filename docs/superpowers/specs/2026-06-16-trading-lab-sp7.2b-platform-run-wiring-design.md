# SP-7.2b — Wire Platform-backed Run Lifecycle into Hypothesis Build

- **Date:** 2026-06-16
- **Slice:** SP-7.2b (second half of SP-7.2; wiring after the SP-7.2a capability)
- **Branch:** `sp7.2b-platform-run-wiring` (off `main`)
- **Builds on:** SP-7.2a (`ResearchPlatformPort` lifecycle + `runOverlayBacktest` + `mapPlatformComparison`, merged PR #18 → `main` `f078567`), SP-7.1/7.1b (`validateModule` + `toSubmittedBundle` + 017 overlay manifest), SP-8.2 (vendored SDK `0.3.0`), trading-platform 037 (`submitted_overlay`) + 038 (7-metric coverage)
- **Followed by:** SP-7.3 (callback/resume of pending platform runs)

## Problem

SP-7.2a delivered the platform-backed backtest lifecycle as a standalone capability behind `ResearchPlatformPort` (submit → bounded poll → result → `mapPlatformComparison`), exercised only by the `platform:run` CLI probe. The orchestrator still backtests **exclusively** through the SP-4 mock `PlatformGatewayPort`: `hypothesisBuildHandler` calls `services.platform.submitBacktest` / `getBacktestResult` and never touches `services.researchPlatform`. SP-7.2b wires the capability into the real handler flow so a built hypothesis overlay `ModuleBundle` can be run against the platform, persisted, and fed into the existing `evaluateBacktest`/`Evaluation` path — while the SP-4 path stays the default and behaviorally unchanged.

## Goal

Give `hypothesisBuildHandler` two backend paths selected by `BACKTEST_BACKEND` (env default) + an optional per-run `payload.backtestBackend` override:

1. **`sp4_mock`** (default) — the existing SP-4 `PlatformGatewayPort` path, behavior unchanged (regression-tested).
2. **`research_platform`** — build `ModuleBundle` → `researchPlatform.validateModule` pre-submit gate → `submitOverlayRun` → **persist `BacktestRun` immediately** → bounded poll/result via the SP-7.2a capability → on `completed`, `mapPlatformComparison` → the shared completion+evaluation tail → `Evaluation`.

The **end-to-end KEY CHECK** is the `research_platform` path producing a persisted `Evaluation` from a completed comparison, offline, against the in-process `MockResearchPlatformAdapter`.

## Decisions (locked)

1. **Backend fork = Approach A:** inline branch in `hypothesisBuildHandler`; extract `runPlatformBacktest(...)` (platform branch) and `finalizeBacktestCompletion(...)` (shared completion+evaluation tail used by *both* backends). The SP-4 mock path's *behavior* stays byte-identical (same events, same persistence calls, same order) even though the completion tail moves into the shared helper — guarded by an SP-4 regression test.
2. **Run config source = payload-required, fail-closed.** When the effective backend is `research_platform`, `payload.platformRun` is mandatory; absent/incomplete ⇒ `build_failed` (code `missing_platform_run_config`), no submit. No env coupling for run identity.
3. **Persistence = forward.** `BacktestRun` gains `backend` (NOT NULL default `'sp4_mock'`), `resumeToken: string|null`, `platformRun: PlatformRunConfig|null`; the existing `platformRunId` holds the research job `runId`. Forward-persisted so SP-7.3 resume needs no further migration.
4. **Pending = stay `'submitted'`.** A poll-exhausted run keeps status `'submitted'` (already persisted), emits `backtest.pending`, and returns with no evaluation. No new repo method. SP-7.3 resumes from `status='submitted'` + `resumeToken`.
5. **Persist-immediately-after-submit** (adjustment A): `runPlatformBacktest` calls the `ResearchPlatformPort` lifecycle methods directly — `submitOverlayRun` → `createSubmitted` → bounded poll — rather than treating `runOverlayBacktest` as an opaque atomic call. SP-7.2a's `run-backtest.ts` is refactored to expose `pollOverlayRun(port, runId, poll)`; `runOverlayBacktest` keeps unchanged behavior (`submitOverlayRun` then `pollOverlayRun`).
6. **`MetricMappingError` = deterministic non-retryable result failure** (adjustment): record as `markFailed` + `backtest.failed` with `{ reason: 'result_invalid', detail: 'metric_mapping_error', code }` and return cleanly — do **not** throw for BullMQ retry. `GatewayRunError` / transport / DB errors still throw and retry.
7. **Backend enum = `'sp4_mock' | 'research_platform'`** (adjustment C). `BACKTEST_BACKEND=sp4_mock` means the legacy SP-4 `PlatformGatewayPort` path — **not** the `ResearchPlatformPort` mock adapter (which is selected independently by `TRADING_PLATFORM_INTEGRATION=mock`).
8. **`baselineVersion`** = env `TRADING_PLATFORM_BASELINE_VERSION` (default `'v1'`) for the baseline `Ref` — a temporary convention (adjustment). Documented: a live gateway may reject if `strategy:<profileId>@v1` is not catalog-resident.

## Key facts (verified)

- `hypothesisBuildHandler` (`src/orchestrator/handlers/hypothesis-build.handler.ts`) today: parse `{hypothesisId, params?}` → load hypothesis(validated)+profile → `createGenerating` build → builder → `assembleBundle`+`validateBundle` (`build_failed` routing) → artifact `put` + `markCandidate` → `paramsHash = sha256(stableStringify(params))` → `findByIdentity(hypothesisId, paramsHash, bundleHash)` (reuse short-circuit) → `submitBacktest` → `createSubmitted` (status `'submitted'`) + `markSubmitted` → `getBacktestResult` → on `completed`+comparison: `markCompleted` + `evaluateBacktest` + `Evaluation` + `markEvaluated`; else `markRejected` + `backtest.failed`. `sha256`/`stableStringify`/`event`/`errMsg` are local; `randomUUID` from `node:crypto`.
- `services` is `AppServices` (`src/orchestrator/app-services.ts`) and **already contains `researchPlatform: ResearchPlatformPort`** (SP-7.2a). `composeRuntime` (`src/composition.ts`) sets `platform: new MockPlatformGatewayAdapter()` and `researchPlatform: selectResearchPlatform(env.TRADING_PLATFORM_INTEGRATION)`, registers `hypothesis.build → hypothesisBuildHandler`, and threads `env.evaluatorThresholds`.
- `selectResearchPlatform('mock'|'mcp')` returns `MockResearchPlatformAdapter` or the boot-safe `LazyMcpResearchPlatformAdapter`. `BACKTEST_BACKEND` (handler lifecycle) and `TRADING_PLATFORM_INTEGRATION` (research transport) are **independent axes**; `research_platform` + `mock` = the offline KEY CHECK.
- `loadEnv` (`src/config/env.ts`) returns `Env`; existing pattern: typed parse with fallbacks (`parsePositiveInt`, `parseFloatOr`, `parsePort`, string-equality flags). `evaluatorThresholds` composed here.
- SP-7.2a capability: `runOverlayBacktest(port, bundle, opts: SubmitOverlayRunOptions, poll: PollOptions): Promise<PlatformRunOutcome>`; `PlatformRunOutcome` = `{status:'completed',runId,summary:RunResultSummary,artifactIds}` | `{status:'pending',runId}` | `{status:'rejected',runId,terminalCode?}`. `mapPlatformComparison(summary): ComparisonSummary` (the **SP-4 `ComparisonSummary`** shape — `{baseline,variant:BacktestMetricBlock, sampleSize, platformContractVersion}`) — throws `MetricMappingError` (`missing_metric` | `ambiguous_profit_factor`). `SubmitOverlayRunOptions` = `{baselineModuleRef: Ref, run: PlatformRunConfig, correlationId?, resumeToken?, workflowId?}`. `PlatformRunConfig` = `{datasetId, symbols, timeframe, period:{from,to}, seed}`. SDK `Ref` = `{id: string; version: string}`. `isTerminal` re-exported from the port.
- `evaluateBacktest(summary: ComparisonSummary, t: EvaluatorThresholds): EvaluationOutcome` is unchanged. `BacktestCompletion` = `{metrics, baselineMetrics, deltaNetPnlUsd, deltaMaxDrawdownPct, isFragile, artifactRefs, platformContractVersion, finishedAt}`.
- Persistence: `backtest_run` table (`src/db/schema.ts`) flattens variant metrics into columns, stores `baselineMetrics` as jsonb, with unique index `backtest_run_idem_uq (hypothesis_id, params_hash, bundle_hash)`. `BacktestRunRepository` = `createSubmitted / markCompleted / markRejected / markFailed / markEvaluated / findById / findByIdentity / listByHypothesis`. Migrations are **drizzle-kit-generated** (`migrations/000N_*.sql` + `meta/`, latest `0006`; `pnpm db:generate` / `pnpm db:migrate`; `drizzle.config.js`). `DrizzleBacktestReadAdapter.toDomain` maps the full row → domain `BacktestRun`; the read API returns that, so new domain fields surface automatically (additive).
- Worker (`src/worker/worker.ts`): handler success = return, failure = throw; the worker sets `running`/`completed`/`failed` and BullMQ retries on throw. The handler must NOT set task status itself.

## Design

### 1. Selector & config (additive)

`Env` + `loadEnv` gain:
- `BACKTEST_BACKEND: 'sp4_mock' | 'research_platform'` — `source.BACKTEST_BACKEND === 'research_platform' ? 'research_platform' : 'sp4_mock'` (default `sp4_mock`).
- `PLATFORM_RUN_MAX_POLLS: number` (`parsePositiveInt`, default `30`), `PLATFORM_RUN_POLL_DELAY_MS: number` (`parsePositiveInt`, default `2000`).
- `TRADING_PLATFORM_BASELINE_VERSION: string` (default `'v1'`).

`AppServices` gains (set in `composeRuntime` from `env`):
- `backtestBackend: 'sp4_mock' | 'research_platform'`
- `platformPoll: { maxPolls: number; pollDelayMs: number }`
- `baselineVersion: string`

`researchPlatform` is already present — no composition change beyond the three new fields.

### 2. Payload schema + missing-config routing

`HypothesisBuildPayloadSchema` gains optional fields:

```ts
backtestBackend: z.enum(['sp4_mock', 'research_platform']).optional(),
platformRun: z.object({
  datasetId: z.string().min(1),
  symbols: z.array(z.string().min(1)).min(1),
  timeframe: z.string().min(1),
  period: z.object({ from: z.string().min(1), to: z.string().min(1) }),
  seed: z.number().int(),
}).optional(),
```

Effective backend = `payload.backtestBackend ?? services.backtestBackend`. The handler resolves the effective backend right after loading hypothesis+profile and **after `createGenerating`**; if `research_platform` and `payload.platformRun` is undefined → `markBuildFailed(buildId, [{code:'missing_platform_run_config', severity:'error', path:'platformRun', message:...}])` + `build_failed` event + return (before the builder runs — no wasted LLM work, no submit).

### 3. Backend-aware `paramsHash`

`computeParamsHash` (new local/util) — mock branch stays **byte-identical**:

```ts
sp4_mock:          sha256(stableStringify(params))                       // unchanged
research_platform: sha256(stableStringify({
  backend: 'research_platform',
  params,
  baseline: { id: baselineRef.id, version: baselineRef.version },
  platformRun: {
    datasetId: platformRun.datasetId,
    symbols: [...platformRun.symbols].sort(),                            // canonicalize order
    timeframe: platformRun.timeframe,
    period: { from: platformRun.period.from, to: platformRun.period.to },
    seed: platformRun.seed,
  },
}))
```

`stableStringify` already sorts object keys; `symbols` is explicitly sorted so `[BTC,ETH]` and `[ETH,BTC]` share identity. The `research_platform` object always carries the `backend` discriminator, so a platform hash can never collide with a mock hash. The unique index is unchanged (backend-awareness folded into the hash value).

`findByIdentity(hypothesisId, paramsHash, bundleHash)` runs (as today) **before** any platform side-effect; a hit short-circuits to `backtest.reused` + return for both backends. In particular, when the hit is an existing `research_platform` run with `status='submitted'` (a pending run): emit `backtest.reused`, return cleanly, **do not** re-submit, and **do not** poll/resume in SP-7.2b — SP-7.3 owns resume of submitted `research_platform` runs.

### 4. Platform branch — `runPlatformBacktest(...)` (new file, e.g. `src/orchestrator/handlers/run-platform-backtest.ts`)

Called from the handler after the idempotency miss, with `{ services, task, buildId, bundle, profile, params, platformRun, paramsHash, baselineRef, resumeToken }`.

The handler derives, before the call: `baselineRef = { id: 'strategy:' + profile.id, version: services.baselineVersion }`; `resumeToken = sha256(stableStringify({ v: 1, hypothesisId, paramsHash, bundleHash }))` (deterministic over identity, so a worker-retry re-submit is an idempotent replay); and the `research_platform` `paramsHash` (§3, which itself consumes `baselineRef` + `platformRun`).

1. **Pre-submit gate:** `report = await services.researchPlatform.validateModule(bundle)`. If rejected (blocking issues), map `ValidationReport` → `ValidationIssue[]` (reuse the SP-7.1 `validate-probe` issue mapping) → `markBuildFailed(buildId, issues)` + `build_failed` event → **return, no submit**. On pass, emit `build.platform_validated` (additive).
2. **Submit:** `opts: SubmitOverlayRunOptions = { baselineModuleRef: baselineRef, run: payload.platformRun, correlationId: task.correlationId, resumeToken }`. `handle = await services.researchPlatform.submitOverlayRun(bundle, opts)`. (A thrown `GatewayRunError`/transport error propagates — see §6; nothing persisted yet; `resumeToken` makes the retry's re-submit an idempotent replay.)
3. **Persist immediately** (adjustment A): build the `BacktestRun` and `createSubmitted` with `status='submitted'`, `backend='research_platform'`, `platformRunId=handle.runId`, `resumeToken`, `platformRun=payload.platformRun`, `baselineModuleId=baselineRef.id`, `variantModuleId=bundle.manifest.moduleId`, `correlationId=task.correlationId`, `params`, `paramsHash`, `bundleHash`, `platformContractVersion='pending'`, `sdkContractVersion`, metrics null. Then `markSubmitted(buildId)` + `backtest.submitted` event.
4. **Bounded poll/result** (reused capability): `outcome = await pollOverlayRun(services.researchPlatform, handle.runId, { maxPolls: services.platformPoll.maxPolls, pollDelayMs: services.platformPoll.pollDelayMs })`. Branch:
   - **completed:** `let comparison; try { comparison = mapPlatformComparison(outcome.summary) } catch (e) { if MetricMappingError → markFailed(runId) + backtest.failed {reason:'result_invalid', detail:'metric_mapping_error', code:e.code} + return; else rethrow }`. On success → `finalizeBacktestCompletion(services, task, { runId, hypothesisId, comparison, artifactRefs: outcome.artifactIds })`.
   - **pending:** `backtest.pending` event (carry `runId`, `resumeToken`) → return. Run stays `'submitted'`, no evaluation.
   - **rejected:** `markRejected(runId)` + `backtest.failed` event (carry `runId`, `terminalCode`) → return.

### 5. Shared completion tail — `finalizeBacktestCompletion(...)` (extracted verbatim from the current SP-4 tail)

```ts
finalizeBacktestCompletion(services, task, { runId, hypothesisId, comparison, artifactRefs }):
  const c = comparison;
  const completion: BacktestCompletion = {
    metrics: c.variant, baselineMetrics: c.baseline,
    deltaNetPnlUsd: c.variant.netPnlUsd - c.baseline.netPnlUsd,
    deltaMaxDrawdownPct: c.variant.maxDrawdownPct - c.baseline.maxDrawdownPct,
    isFragile: c.variant.topTradeContributionPct >= services.evaluatorThresholds.fragilityTopTradePct,
    artifactRefs, platformContractVersion: c.platformContractVersion, finishedAt: now(),
  };
  await services.backtests.markCompleted(runId, completion);
  await services.events.append(event(task.id, 'backtest.completed', { runId, deltaNetPnlUsd: completion.deltaNetPnlUsd }));
  const outcome = evaluateBacktest(c, services.evaluatorThresholds);
  const evaluation: Evaluation = { id: randomUUID(), backtestRunId: runId, hypothesisId, decision: outcome.decision, reasons: outcome.reasons, metricsSnapshot: c, thresholds: services.evaluatorThresholds, createdAt: now() };
  await services.evaluations.create(evaluation);
  await services.backtests.markEvaluated(runId);
```

The **`sp4_mock` branch** stays inline through `submitBacktest` → `createSubmitted` (now also sets `backend:'sp4_mock'`, `resumeToken:null`, `platformRun:null`) → `markSubmitted` → `getBacktestResult`; on `completed`+comparison it calls the *same* `finalizeBacktestCompletion`; else `markRejected` + `backtest.failed` (unchanged). `hypothesisId` is threaded into the helper (it is not on `ComparisonSummary`).

### 6. Error semantics (three classes)

- **Infra / retryable → throw (task fails → BullMQ retry):** `GatewayRunError` and any transport error from `submitOverlayRun` / `pollOverlayRun`’s `getRunStatus` / `getRunResult`; DB errors. Nothing marked rejected. Because the run row is persisted right after submit, a poll-phase throw leaves a `'submitted'` row; the retry's `findByIdentity` reuses it (no re-submit) and the run remains pending for SP-7.3 resume.
- **Business terminal → record + return (task completes):** platform `rejected` outcome ⇒ `markRejected` + `backtest.failed` (`terminalCode`); `validateModule` rejection ⇒ `build_failed`.
- **Deterministic data error → record + return, non-retryable:** `MetricMappingError` ⇒ `markFailed` + `backtest.failed` (`result_invalid` / `metric_mapping_error`).

### 7. Persistence (domain + schema + migration)

- Domain `BacktestRun` (`src/domain/backtest-run.ts`) gains `backend: 'sp4_mock' | 'research_platform'`, `resumeToken: string | null`, `platformRun: PlatformRunConfig | null` (imported from `research-platform.port.ts`, mirroring the existing `BacktestMetricBlock`-from-port precedent). `BacktestRunStatus` unchanged.
- `backtest_run` schema gains `backend: text('backend').notNull().default('sp4_mock')`, `resumeToken: text('resume_token')`, `platformRun: jsonb('platform_run').$type<PlatformRunConfig>()`. Run `pnpm db:generate` → commit the generated `0007_*.sql` + `meta/` snapshot (backfill-safe: `backend` defaults `'sp4_mock'` for existing rows; the other two are nullable).
- `DrizzleBacktestRunRepository.createSubmitted` inserts the three columns; its `toDomain` and `DrizzleBacktestReadAdapter.toDomain` map them back; `InMemoryBacktestRunRepository` already spreads the run (carries the new fields). Read API surfaces `backend`/`resumeToken`/`platformRun` automatically.

### 8. Baseline ref convention

`baselineRef: Ref = { id: 'strategy:' + profile.id, version: services.baselineVersion }`. For the offline KEY CHECK the version is opaque (the mock adapter ignores it). **Live caveat:** a real gateway rejects the run if `strategy:<profileId>@<version>` is not trusted-catalog-resident; resolving the real catalog version is a later-slice/live concern.

### 9. Events (additive)

Reuse existing `build.started` / `builder.*` / `build.validated` / `build_failed` / `artifact.stored` / `backtest.reused` / `backtest.submitted` / `backtest.completed` / `backtest.failed`. **New:** `backtest.pending`, `build.platform_validated`. (The `platform.run.*` events stay in the SP-7.2a probe; the handler stays in the `backtest.*` family for consistency with SP-4.)

### 10. Capability refactor (SP-7.2a `run-backtest.ts`)

Extract `export async function pollOverlayRun(port, runId, poll: PollOptions): Promise<PlatformRunOutcome>` (the current poll loop + `getRunResult` + completed/rejected/pending resolution). Re-express `runOverlayBacktest` as `const handle = await port.submitOverlayRun(bundle, opts); return pollOverlayRun(port, handle.runId, poll);`. Behavior of `runOverlayBacktest` is unchanged — its existing unit tests + the `platform:run` probe are the regression guard.

## Acceptance

Offline, deterministic (Vitest); the in-process `MockResearchPlatformAdapter` for the completed KEY CHECK, inline `ResearchPlatformPort` stubs for pending/rejected/validate-rejected:

- **KEY CHECK — `research_platform` completed → evaluation:** with `backtestBackend='research_platform'` (env or payload) and a `MockResearchPlatformAdapter` returning a completed comparison, the handler drives build → `validateModule`(pass) → submit → `createSubmitted`(submitted, `backend='research_platform'`, `platformRunId`, `resumeToken`, `platformRun`) → poll(terminal) → `mapPlatformComparison` → `markCompleted` → `evaluateBacktest` → `Evaluation` persisted; final `BacktestRun` is `status='evaluated'` with mapped metrics, and the `Evaluation.decision` matches the comparison.
- **Pending:** stub `getRunStatus` non-terminal up to `maxPolls` ⇒ run stays `'submitted'`, `backtest.pending` emitted, no `Evaluation`.
- **Rejected:** stub terminal-non-completed ⇒ `markRejected` + `backtest.failed` (`terminalCode`), no `Evaluation`.
- **`MetricMappingError`:** stub a completed-but-ambiguous comparison ⇒ `markFailed` + `backtest.failed` (`result_invalid`/`metric_mapping_error`), returns cleanly (no throw).
- **validate-rejected:** `validateModule` returns a blocking report ⇒ `build_failed`, **no submit** (stub `submitOverlayRun` asserts not-called).
- **missing-config:** `backtestBackend='research_platform'` + no `payload.platformRun` ⇒ `build_failed` (`missing_platform_run_config`), no builder side-effects, no submit.
- **Backend-aware idempotency:** second trigger with identical identity ⇒ `backtest.reused`; a `sp4_mock` run and a `research_platform` run for the same `(hypothesisId, params, bundle)` get **different** `paramsHash` (no collision); a `sp4_mock` `paramsHash` equals the pre-7.2b value byte-for-byte.
- **Existing submitted `research_platform` reuse:** retriggering an identity whose `research_platform` `BacktestRun` is already `status='submitted'` ⇒ `backtest.reused` emitted, `submitOverlayRun` asserted **not-called**, no poll/resume, no `Evaluation`. (SP-7.3 owns resume of submitted `research_platform` runs.)
- **Infra error:** `submitOverlayRun`/poll throwing `GatewayRunError` ⇒ the handler throws (task retried), no `markRejected`/`markFailed`.
- **SP-4 regression:** the default `sp4_mock` path (no payload backend) produces the same events, persistence calls, and `Evaluation` as before this slice.
- **Migration:** `0007_*.sql` applies on a populated DB; existing rows backfill `backend='sp4_mock'`.
- **Boundary + suite:** `sdk-import-boundary.guard.test.ts` still green (no new SDK imports outside the port/adapters); `pnpm typecheck` clean; `pnpm test` ≥ current baseline + new tests; `runOverlayBacktest`/probe tests still green after the `pollOverlayRun` extraction.
- **Live round-trip = gateway-pending** (like SP-7.1/7.2a): a real `research_platform` run against a 037/038 gateway + a catalog-resident baseline is recorded as pending; the offline mock acceptance is this slice's bar.

## Definition of Done

A `hypothesis.build` task with `backtestBackend='research_platform'` + a valid `payload.platformRun` is driven, offline, through validate → submit → persist → bounded poll → completed comparison → `evaluateBacktest` → persisted `Evaluation`, with the `sp4_mock` path behaviorally unchanged, the new persisted fields round-tripping through the DB + read API, and the SDK boundary intact.

## Risks

- **Shared-tail extraction touches the SP-4 path's code** (not behavior) — mitigated by an explicit SP-4 regression test asserting unchanged events/persistence/evaluation.
- **Persist-after-submit window:** a crash between a successful `submitOverlayRun` and `createSubmitted` could orphan a platform run; the deterministic `resumeToken` (idempotent replay) bounds the blast radius to a duplicate-suppressed re-submit on retry.
- **`baselineVersion='v1'` is a placeholder:** offline-safe, but a live gateway rejects a non-catalog-resident `strategy:<id>@v1` — surfaces only on the live round-trip.
- **`pollOverlayRun` extraction** must preserve `runOverlayBacktest` semantics exactly — guarded by the existing capability tests + probe.
- **Pending runs accumulate as `'submitted'`** with no resolution until SP-7.3; acceptable and explicit for this slice.
