# Strategy Baseline ExperimentService Lane — Design Spec (Slice A)

**Date:** 2026-07-01
**Repo:** trading-lab
**Status:** APPROVED design (reviewed) — ready for implementation plan
**Roadmap:** `2026-06-30-backtest-research-orchestrator-roadmap.md` (Phase A/C foundations) — this is the **Slice A** prerequisite that must precede the decision-agent (Slice B) and its model eval (Slice C).

## 0. Where this sits

The user goal is the end-to-end Cycle-1 pre-paper loop on the one real code-based long strategy (`long_oi`):

```
bot code → analyst → StrategyProfile (DB) → strategy builder → strategy bundle (artifact)
  → FIRST real backtest (baseline)            ← THIS SLICE (A)
  → decision-agent picks further backtests (sweep) → paper / reject   ← Slice B
  → decision-agent model eval                                          ← Slice C
```

PR #119 shipped the **overlay** validation lane (`ExperimentService.runNewStrategyValidation`: sanity→train→holdout for an overlay-on-a-baseline hypothesis). It cannot validate the **strategy itself** — the base entity every overlay/hypothesis builds on. For a genuinely new strategy the base entity is a **standalone strategy bundle** submitted with `engine:'strategy'`; an overlay-on-a-nonexistent-base cannot run against the real engine (the backtester trusted registry contains only `shortAfterPump`, not `long_oi`). This slice teaches `ExperimentService` the missing **strategy baseline lane**.

## 1. Guarantee & scope

> **`ExperimentService` can run a first *baseline* experiment for a standalone strategy bundle against the real `trading-backtester` (`engine:'strategy'`), persist the run + experiment, read the real trades artifact, and render an absolute-metrics verdict — with the strategy `bundle_hash` fixed as the anchor point for all future overlays/sweeps.**

Concretely this slice proves the whole chain runs on **real** data over the mock's ~6-day slice, and produces the real baseline result Slice B's decision-agent will consume.

**In scope:**
1. `strategy_backtest_run` persistence (Approach 2, below).
2. A metrics-producing `engine:'strategy'` submit on `ResearchPlatformPort` (`submitStrategyResearchRun`) + adapters.
3. Variant-only metric mapping + an absolute-metrics baseline evaluator.
4. `StrategyExperimentRunExecutor` (`engine:'strategy'`, no overlay/baselineRef) with its **own** request/result types.
5. `ExperimentService.runStrategyBaselineValidation(...)` reusing the holdout/train/evaluate core.
6. Strategy builder wired into `AppServices` + composition.
7. Seed: persist the `long_oi` profile via a **real `strategy.onboard`** run on the vendored bot code.
8. A one-shot trigger (script) that runs the baseline end-to-end + captures the result.
9. Real-backtester host-process runbook (+ mock-platform) and the trades-artifact adapter verification.
10. Minimal read surface: the **experiment** read API surfaces members with `strategyBacktestRunId` + result summary.

**Explicitly NOT in scope** (deferred): decision-agent / sweep-designer / result-interpreter, `ParamGridRunner` (Slice B); decision-agent model eval (Slice C); multi-fold WFA/WFO (data-gated, ≥60d); office panels; S3/object-store artifacts (local FS is adequate "for now"); a dedicated `/strategy-backtests` read endpoint (the experiment read surfaces the member linkage instead); a statistically-valid holdout (the 6-day slice degrades to `INCONCLUSIVE` by design — see §11); per-role mid-flight resume / async webhook re-invoke (single-pass terminal only — see §7.1).

## 2. Decisions taken

- **Seed = real onboard on code.** A seed path runs the real `strategy.onboard` handler on the vendored `long_oi` bot code (kind `bot_code`) → analyst → `strategyProfiles.create`. Matches the intended cycle (`code → analyst → profile → DB`) and is fingerprint-idempotent (re-runs are no-ops via `findByFingerprint`). Costs one analyst LLM call.
- **Baseline semantics = standalone strategy bundle.** The first backtest is the as-authored strategy (`assembleStrategyBundle` from the profile), submitted `engine:'strategy'` — **not** a researcher overlay and **not** a synthetic hypothesis.
- **Persistence = Approach 2 (separate `strategy_backtest_run` table).** Blast-radius analysis (see §4.1) shows extending `BacktestRun` is a false economy: its unique idempotency index `backtest_run_idem_uq` leads with a NOT NULL `hypothesis_id`; relaxing it to null triggers Postgres NULLS-DISTINCT → silent idempotency loss, forcing the identity contract to fork anyway, while leaking nullability into every overlay construction/read site. Approach 2 is additive with the shipped overlay path **zero-diff**.
- **Typed lanes, not relaxed invariants.** The overlay `ExperimentRunRequest`/`Result` are **not** softened to optional hypothesis fields (that would turn compile-time overlay invariants into runtime errors). Instead the two lanes get **distinct** types (`OverlayExperimentRunRequest`/`Result` — the existing ones — and new `StrategyExperimentRunRequest`/`Result`), each with its required fields intact.
- **Baseline verdict = absolute metrics, not delta.** A standalone strategy run returns metrics with **no** `comparison` (no overlay baseline to diff against). PR #119's `evaluateExperiment` / `mapPlatformComparison` are delta-vs-baseline and cannot be reused unchanged; the baseline lane gets its own variant-only mapping + `evaluateStrategyBaseline`. **A sanity-only baseline (no viable holdout) can never yield `PAPER_CANDIDATE`** — see §6.
- **Single-pass terminal lifecycle.** The baseline flow runs to a terminal state in one pass, idempotent at the completed-experiment level (like PR #119). No per-role resume / webhook re-invoke — see §7.1.
- **Real backtester as a host process.** `trading-backtester` runs as a WSL2 **host** process so its per-run `docker run` reaches Docker Desktop natively (the prior `ENOENT` was the engine running *inside* a container without the docker socket). No DinD needed.

## 3. Architecture / flow

Plain TypeScript on `AppServices` + `ExperimentService` — no Mastra workflow (consistent with PR #119). Emits `events.append(...)` per phase.

```
seed: strategy.onboard(bot_code = vendored long_oi) → StrategyProfile persisted (id printed)

trigger (one-shot script):
  load profile from DB
  → strategyBuilder.build({spec, authoringDoc, profile}) → assembleStrategyBundle → StrategyBundle {bytes, manifest(kind:'strategy'), bundleHash}
  → artifacts.put(bundle)                 (local FS, audit anchor)
  → ExperimentService.runStrategyBaselineValidation({ strategyProfileId, strategyBundle, datasetScope, runConfig, holdoutPolicy? })
       create ResearchExperiment(type=strategy_baseline_validation, status=running)
       ├─ SANITY: engine:'strategy' full-period run   (gate + trade-distribution source)
       │     gate: executes ∧ totalTrades>0 ∧ metrics non-garbage   FAIL → verdict FAIL / sanity_failed
       ├─ getRunTrades(sanity.platformRunId) → TradeRecord[]   (contentHash/page artifact contract, §9)
       ├─ resolveHoldoutBoundary(trades, period, policy) → HoldoutBoundary
       │     6-day slice → mode='none' (insufficient history/trades) → finalize INCONCLUSIVE  (expected demo path)
       ├─ TRAIN: engine:'strategy' [from,T)   (only if boundary viable)
       ├─ HOLDOUT: engine:'strategy' [T,to]
       └─ evaluateStrategyBaseline(sanity|train|holdout metrics, boundary) → experiment_evaluation + verdict
  → print { experimentId, verdict, sanity metrics, totalTrades }   ← captured baseline for Slice B
```

Each run leg is delegated to the injected **`StrategyExperimentRunExecutor`** (submit `engine:'strategy'` → persist `strategy_backtest_run` → poll → map metrics). The holdout boundary / train-holdout split / member-recording machinery is reused verbatim from PR #119; only the executor, the mapper, the evaluator, and the persistence target differ.

### 3.1 Audit events (explicit)

The baseline lane emits, mirroring PR #119's per-phase convention, each carrying `experimentType:'strategy_baseline_validation'` + `experimentId`:
- `experiment.started` (on create), `experiment.completed` / `experiment.failed` (terminal, with `verdict` + `verdictReason`).
- Per member: `experiment.member.started`, `experiment.member.completed` (with `role`, `platformRunId`, `totalTrades`, `metrics`), `experiment.member.failed`.
- `experiment.boundary.resolved` (mode, `T`, train/holdout trade counts, `lowConfidence`).

These are asserted in tests (PR #119 caught this regression class — events must not silently drop).

## 4. Data model

### 4.1 Persistence approach — `strategy_backtest_run` (Approach 2)

New table + domain type `StrategyBacktestRun` (mirrors `BacktestRun` conventions: app-generated text ids, no FKs, no PG enums, jsonb `$type<...>`, tz timestamps). It drops the overlay/hypothesis columns (`hypothesisId`, `hypothesisBuildId`, `baselineModuleId`, `variantModuleId`) and adds:

| column | type | notes |
|---|---|---|
| `id` | text PK | app-generated |
| `strategy_profile_id` | text | |
| `strategy_bundle_id` | text | the bundle's own `manifest` module id (identity anchor) |
| `bundle_hash` | text | strategy `bundleHash` |
| `params_hash` | text | `computeStrategyParamsHash(...)` — §7.2 (NOT the overlay `computeParamsHash`) |
| `run_kind` | text `$type<'strategy_baseline'>` | reserved for future strategy run kinds |
| `platform_run_id` | text | backtester run id |
| `correlation_id`, `task_id?`, `resume_token?` | text | lifecycle/idempotency |
| `status` | text `$type<BacktestRunStatus>` | reuse the existing status union |
| `params` | jsonb | request overlay params (`{}` for baseline) |
| `metrics` | jsonb? `$type<BacktestMetricBlock>` | absolute strategy metrics; null until completed |
| `platform_run` | jsonb? | resolved run config |
| `artifact_refs` | jsonb `$type<string[]>` | |
| contract-version + `submitted_at` / `created_at` / `updated_at` / `finished_at?` | | mirror `backtest_run` |

Unique index `strategy_backtest_run_idem_uq (strategy_bundle_id, params_hash, bundle_hash)` — **no null column**, clean idempotency. New repository port `StrategyBacktestRunRepository` (`createSubmitted`, `markCompleted`, `markRejected`, `markFailed`, `findById`, `findByPlatformRunId`, `findByIdentity(strategyBundleId, paramsHash, bundleHash)`) + drizzle + in-memory adapters. Additive migration (next `0014_*`).

### 4.2 Experiment linkage + XOR invariant

`experiment_run_member` is already hypothesis-agnostic (`backtestRunId` nullable, no hypothesis reference). The **one** shared edit: add nullable `strategy_backtest_run_id` so a baseline experiment's members can point at the strategy run.

**XOR invariant (mandatory):** a member references **exactly one** run:
- overlay member: `backtestRunId != null` ∧ `strategyBacktestRunId == null`.
- strategy member: `backtestRunId == null` ∧ `strategyBacktestRunId != null`.

Enforced in the service/mapper (a member is never written with both or neither set) and covered by a unit test on the member writer + the DTO mapper. (Kept as an application invariant, not a DB CHECK, to match the repo's "no DB-level constraints beyond indexes" convention — but the plan may add a CHECK if cheap.)

`ResearchExperiment.experimentType` gains `'strategy_baseline_validation'` (the union already reserves forward values). Everything else on `research_experiment` / `experiment_evaluation` is reused unchanged. Read API: `ExperimentRunMemberDto` gains `strategyBacktestRunId` (null-preserving); **no** separate strategy-run route.

## 5. Strategy submit path (port + adapters)

The SDK/backtester already support `engine:'strategy'` (`BacktestEngine = 'momentum'|'overlay'|'strategy'`; `BacktesterClient.submitRun`; server `submit.ts` validates `engine==='strategy'` ⇒ non-empty `metrics` + `manifest.kind==='strategy'`). Lab's existing `HttpBacktesterAdapter.submitStrategyRun` is a **golden-hash equivalence probe** (returns `signed/equivalent/divergent`, no metrics) via `BacktesterStrategyPort` — **not reusable**, and its name is taken. New work:

- **Port:** add **`submitStrategyResearchRun(bundle: StrategyBundle, opts): Promise<RunJobHandle>`** to `ResearchPlatformPort` (name chosen to avoid the `BacktesterStrategyPort.submitStrategyRun` collision; returns a pollable handle so it flows through the existing `getRunStatus`/`getRunResult` lifecycle via the engine-agnostic `pollResearchRun` (§7.3)). `opts` carries the run config; **no** `target`/preset/`baselineRef`.
- **HTTP adapter:** build a `RunSubmitRequest { engine:'strategy', moduleRef:{id,version} of the bundle's own manifest, moduleBundle (SDK `createModuleBundle({manifest, entry:'index.js', files:{'index.js': decode(bytes)}})`), datasetRef/symbols/timeframe/period/seed, mode:'research', metrics: <non-empty from OVERLAY_METRIC_CATALOG> }`. Model the wire-bundle construction on the existing equivalence-probe `submitStrategyRun` but return a `RunJobHandle` instead of comparing hashes.
- **Mock adapter:** `MockResearchPlatformAdapter.submitStrategyResearchRun` for offline/in-memory tests (a fake run handle + canned metrics; the real slice runs against the host backtester).

## 6. Variant-only mapping + baseline evaluation

- **`mapStrategyMetrics(summary): BacktestMetricBlock`** (new) — reads `summary.metrics` (the strategy engine emits metrics with `comparison` absent). Reuses `BacktestMetricBlock` (`netPnlUsd, netPnlPct, totalTrades, winRate, profitFactor, maxDrawdownPct, expectancyUsd, sharpe, topTradeContributionPct`) and the `resolveProfitFactors`/`NO_LOSS_PROFIT_FACTOR` edge handling. Does **not** call `mapPlatformComparison` (which requires `summary.comparison` and throws otherwise).
- **`evaluateStrategyBaseline(metrics, boundary, members): ExperimentEvaluation`** (new, pure) — an **absolute-metrics** ladder (is the strategy itself viable: `totalTrades>0`, `profitFactor`/`sharpe`/`maxDrawdown` thresholds). Verdict:
  - **`PAPER_CANDIDATE`** — *only* when a **viable holdout ran and survived** (boundary `mode!='none'`, not `lowConfidence`, holdout metrics pass the floor). A **sanity-only** baseline (no viable holdout split — the 6-day demo path) is **capped at `INCONCLUSIVE`** regardless of how good the sanity metrics look. Promotion requires real out-of-sample evidence, never a single full-period run.
  - **`FAIL`** — a ran window's metrics fall below the viability floor.
  - **`INCONCLUSIVE`** — insufficient trades/history (boundary `mode='none'` or `lowConfidence`), i.e. the expected demo outcome.
  There is **no** overfit/`holdout_failed` delta test here — that concept belongs to the overlay lane; a baseline has no baseline to overfit against. Thresholds frozen into `raw_scores` for audit (mirrors PR #119).

## 7. `StrategyExperimentRunExecutor`

New file implementing a **strategy-specific** executor (parallel to `BacktesterExperimentRunExecutor`), with its own request/result types (no overlay-invariant relaxation):

```ts
interface StrategyExperimentRunRequest { experimentId; role: MemberRole; strategyBundle: StrategyBundle; strategyProfileId; run: PlatformRunConfig; params; }
interface StrategyExperimentRunResult  { status: 'completed'|'pending'|'rejected'; runId; platformRunId; metrics?: BacktestMetricBlock; totalTrades?; }
```

`execute(req)`: `computeStrategyParamsHash(req)` → `submitStrategyResearchRun(req.strategyBundle, opts)` → `strategyBacktests.createSubmitted(...)` (persist `strategy_backtest_run`, status `submitted`) → `pollResearchRun(...)` (§7.3) → on completed `mapStrategyMetrics(summary)` + `markCompleted`; returns the strategy result. The existing overlay `ExperimentRunExecutor` / `ExperimentRunRequest` / `ExperimentRunResult` are renamed `Overlay*` for symmetry (or left as-is), untouched behaviourally.

### 7.3 Polling boundary — `pollResearchRun` (blocker fix)

Today `pollOverlayRun` (`src/research/run-backtest.ts`) classifies a run `completed` **only** if `res.summary.status === 'completed' && res.summary.comparison !== undefined`, else `rejected`. A strategy run has **no `comparison`** (§6), so it would be wrongly classified `rejected`. Fix — split the polling boundary, behaviour-preserving for overlay:

- **`pollResearchRun(platform, runId, poll): PlatformRunOutcome`** (new, engine-agnostic) — waits for a terminal status and returns `completed` when `res.summary.status === 'completed'` (**no `comparison` gate**), else `pending`/`rejected` (with `terminalCode`). Extracts the existing terminal-wait loop.
- **`pollOverlayRun`** becomes a thin wrapper: `pollResearchRun` **then** downgrade a `completed` outcome to `rejected` when `summary.comparison === undefined` — reproducing today's exact overlay behaviour. Both the overlay executor's direct `pollOverlayRun` call and `runOverlayBacktest` keep identical results (the comparison gate is *not* merely hoisted into `runOverlayBacktest`, since the overlay executor calls `pollOverlayRun` directly). Overlay tests must stay green (behavioural zero-diff).
- The strategy executor calls `pollResearchRun` then `mapStrategyMetrics(summary)`; overlay callers keep `pollOverlayRun` then `mapPlatformComparison(summary)`.

### 7.1 Lifecycle (single-pass terminal)

Like PR #119, the flow runs to a **terminal state in one pass**; idempotency is at the **completed-experiment** level (`findByKey` returns a completed experiment without re-running). A run that comes back `pending` (e.g. demo WSL2 nested-docker mishap) finalizes the experiment as terminal `INCONCLUSIVE` / `run_pending` — never a half-finished experiment. The executor's per-run `resumeToken` still gives the backtester submit idempotency, but lab does **not** reconstruct partial experiments. Per-role mid-flight resume + async webhook re-invoke are **out of scope**.

### 7.2 `computeStrategyParamsHash`

A **new** canonical hash — do **not** reuse the overlay `computeParamsHash` (it is bound to `baselineRef`, which a baseline has none of). Shape: `sha256(stableStringify({ v:1, bundleHash, platformRun:{datasetId, symbols:[...sorted], timeframe, period:{from,to}, seed}, params }))`. This is the identity/idempotency basis for the baseline and the foundation Slice B's `request.params` sweep varies against a fixed `bundleHash`.

## 8. `ExperimentService.runStrategyBaselineValidation`

Sibling of `runNewStrategyValidation`. Input `{ strategyProfileId, strategyBundle, datasetScope, runConfig, holdoutPolicy?, objective?, taskId? }` — **no** `hypothesisId`/`buildId`/`baselineRef`. Reuses `resolveHoldoutBoundary`, the sanity→train→holdout sequencing, and member recording; injects the `StrategyExperimentRunExecutor` (a second executor dep or an engine switch) and swaps `evaluateExperiment` for `evaluateStrategyBaseline`. `runMember` records an `ExperimentRunMember` with `strategyBacktestRunId` set and `backtestRunId` null (the §4.2 XOR invariant). Emits the §3.1 events.

## 9. Trades-artifact adapter verification

The Task-0 note (`2026-07-01-holdout-investigation.md`) documents the SDK contract: `getArtifactManifest(runId).descriptors[]` → `ArtifactDescriptor.contentHash` is the id passed to `readArtifact(runId, contentHash, {offset,limit})`, page rows under `ArtifactPage.page`. Plan **verifies** `HttpBacktesterRunTradesAdapter.getRunTrades` reads `descriptor.contentHash` (not `artifactId`) and `.page` (not `.rows`), matching `artifactType==='trades' && availability==='available'`; fixes + unit-tests if it diverges. (Likely already correct — the adapter was written after that note.) The strategy engine produces the same `trades` artifact (`Portfolio.buildTrade` rows with `entryTs`/`exitTs` epoch ms), so the contract holds across engines.

## 10. Wiring, seed, trigger, runbook

- **Composition:** add `strategyBuilder: StrategyBuilder` (via `createStrategyBuilderAgent` + `MastraStrategyBuilder`), `strategyBacktests: StrategyBacktestRunRepository`, and the `StrategyExperimentRunExecutor` to `AppServices`/`composeRuntime`; extend `ExperimentService` deps. Constructor convention: `constructor(deps){ this.x = deps.x }` — **no TS parameter-properties** (strip-types).
- **Seed:** `scripts/seed-long-oi-profile.mts` — read the vendored `long_oi` code dir (`readCodeDir` + `buildCodeSource`, kind `bot_code`), drive the real `strategy.onboard` path, print the persisted `strategyProfileId`. Idempotent by source fingerprint.
- **Trigger:** `scripts/run-strategy-baseline.mts` — compose runtime, load the seeded profile, build the strategy bundle, call `runStrategyBaselineValidation`, print `{experimentId, verdict, metrics, totalTrades}`.
- **Runbook (real engine):** mock-platform up (serves `/historical/rows` over the committed ~6-day fixture); `trading-backtester` as a **host** process — `cd trading-backtester/apps/backtester && pnpm install && BACKTESTER_DATA_SOURCE=mock BACKTESTER_MOCK_PLATFORM_URL=... BACKTESTER_AUTH_TOKEN=... pnpm start` (listens :8080; `docker pull node:24-alpine` first); lab points `BACKTESTER_API_URL=http://127.0.0.1:8080`, `integration='backtester'`, run-trades adapter = `backtester`. **Open item:** confirm whether `engine:'strategy'` is gated by a flag (overlay is gated by `BACKTESTER_ENABLE_OVERLAY_ENGINE=true`) — set whatever `submit.ts` requires for strategy runs.

## 11. Data-reality caveats

The mock's real slice is ~6 days / 5 symbols (default run `ESPORTSUSDT:1h`, `2026-06-12..19`, seed 42; dataset `mock-ds-1`). With `minHistoryDays=30` the holdout resolver returns `mode='none'` → the experiment finalizes **`INCONCLUSIVE`** without a train/holdout split, and (per §6) **cannot** reach `PAPER_CANDIDATE`. This is the **honest, expected** outcome: Slice A proves the *chain* (real submit → real trades → real metrics → persisted experiment), not a statistically-valid holdout. The sanity run's **metrics are real**. A full train/holdout split (and any `PAPER_CANDIDATE`) is demonstrated later on the server with ≥30 days.

## 12. Testing & gates

**Unit (pure):** `evaluateStrategyBaseline` (viable holdout survived → PAPER_CANDIDATE; **sanity-only → capped INCONCLUSIVE, never PAPER_CANDIDATE**; below-floor → FAIL; insufficient → INCONCLUSIVE); `mapStrategyMetrics` (metrics present, comparison absent, profit-factor edges incl. `NO_LOSS_PROFIT_FACTOR`); `computeStrategyParamsHash` determinism (same inputs → same hash; different bundle/period/params → different); `strategy_backtest_run` identity determinism; **member XOR invariant** (writer + mapper reject both-set / neither-set); **`pollResearchRun`** (completed summary w/o `comparison` → `completed`, not `rejected`) + **`pollOverlayRun` delegation** (comparison-absent → still `rejected`, overlay behaviour unchanged).
**Integration:** `StrategyBacktestRunRepository` round-trip (DB-gated) + in-memory parity; experiment read DTO surfaces `strategyBacktestRunId`; `runStrategyBaselineValidation` full flow with a **fake** strategy platform + `FakeRunTradesAdapter` (sanity→INCONCLUSIVE demo-degrade path, and a synthetic ≥30-trade path exercising train/holdout→PAPER_CANDIDATE); audit-event assertions (§3.1).
**Real (acceptance):** the one-shot trigger against the host backtester — captured `{experimentId, verdict, metrics, totalTrades}` with `totalTrades>0` proves the engine+adapter+persist chain.
**Gates before "done":** `pnpm typecheck` explicitly (Vitest passes while `noUncheckedIndexedAccess` fails; `tsc` covers `src/` only — the scripts are `.mts` outside tsconfig, type them manually as the existing scripts do); `pnpm test` green; **overlay path zero-diff** (no behaviour change to `runNewStrategyValidation` / `BacktesterExperimentRunExecutor` / `backtest_run`).

## 13. Build order (confirmation after each)

1. **Persistence** — `StrategyBacktestRun` domain + `strategy_backtest_run` table + migration `0014` + repository (port/drizzle/in-memory); `experiment_run_member.strategy_backtest_run_id` + member DTO field + **XOR invariant** enforcement; `experimentType` union value. Acceptance: strategy runs persist; member XOR holds; overlay path unbroken.
2. **Submit + map** — `ResearchPlatformPort.submitStrategyResearchRun` + HTTP/mock adapters; `mapStrategyMetrics`; `computeStrategyParamsHash`; trades-adapter `contentHash`/`page` verification.
3. **Executor + service + evaluator** — extract `pollResearchRun` + refactor `pollOverlayRun` to delegate (§7.3, overlay tests stay green); `StrategyExperimentRunExecutor` (+ `Strategy*` request/result types), `evaluateStrategyBaseline`, `ExperimentService.runStrategyBaselineValidation`, composition wiring, audit events, integration tests.
4. **Seed + trigger + runbook** — seed script, run script, host-backtester runbook; the captured real run.

## 14. Invariants & gotchas

1. **Strategy baseline ≠ overlay.** No overlay executor, no `baselineRef`, no synthetic hypothesis, no registered base strategy required in the engine.
2. **Typed lanes.** Overlay and strategy executors have **distinct** request/result types; overlay invariants are never relaxed to optional.
3. **Strategy `bundle_hash` is the anchor** for future overlays/sweeps (Slice B varies `request.params` over this fixed hash via `computeStrategyParamsHash`).
4. **Absolute verdict, not delta.** A strategy run has no `comparison`; do not route it through `mapPlatformComparison`/`evaluateExperiment`.
5. **Sanity-only never promotes.** `PAPER_CANDIDATE` requires a viable, survived holdout — never a single full-period sanity run.
6. **Member XOR.** Exactly one of `backtestRunId` / `strategyBacktestRunId` is set.
7. **Own params hash.** `computeStrategyParamsHash` (no `baselineRef`), not the overlay `computeParamsHash`.
8. **Idempotency via `(strategyBundleId, paramsHash, bundleHash)`** — a clean non-null unique index; never relax `backtest_run_idem_uq`.
9. **Single-pass terminal.** Idempotency-by-completed; `pending` → terminal `INCONCLUSIVE`; no per-role resume.
10. **Overlay path behavioural zero-diff** — PR #119 code paths preserved; the only overlay-touching change is refactoring `pollOverlayRun` to delegate to the new `pollResearchRun` + a comparison gate (§7.3), verified by the existing overlay tests staying green.
11. **INCONCLUSIVE ≠ FAIL** — the 6-day degrade is coverage, not strategy failure.
12. **strip-types** — no TS parameter-properties; run `pnpm typecheck`, not just Vitest.
13. **Real engine = host process** — its `docker run` needs a host-reachable Docker daemon; never nest it in a container without the socket.

## 15. Open items for the plan (not blockers)

- Confirm the `engine:'strategy'` flag/gating in `trading-backtester/apps/backtester/src/jobs/submit.ts` (analogue of `BACKTESTER_ENABLE_OVERLAY_ENGINE`).
- Confirm the exact `metrics` list a strategy submit must send (non-empty subset of `OVERLAY_METRIC_CATALOG`) and that the mock/host both honour it.
- Confirm `StrategyBuilderInput.spec` shape for a faithful as-authored build (the roundtrip passes a one-line `description`; decide whether the profile alone suffices).
- Decide trigger form: one-shot script now vs a `strategy.baseline` task-type + handler later (productionization).
- Verify `HttpBacktesterRunTradesAdapter` field names (`contentHash`/`page`) — fix only if it diverges.
