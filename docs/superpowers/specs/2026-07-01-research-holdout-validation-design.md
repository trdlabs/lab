# Research Holdout Validation — Design Spec (🟢 block)

**Date:** 2026-07-01
**Repo:** trading-lab
**Status:** APPROVED design — ready for implementation plan
**Scope:** The 🟢 «СЕЙЧАС» block from `2026-06-30-backtest-research-orchestrator-roadmap.md` §6.0 — and **only** that block.

**Implements:**
1. Experiment Registry / ledger (roadmap Phase A).
2. Holdout Policy by trade-count, single-split (roadmap Phase B.1, single-split form).
3. Two-phase Train/Holdout flow = 1-fold WFA (subset of Phase B).

**Explicitly NOT in scope** (deferred, data-gated): multi-fold WFA, WFO/parameter sweep (`ParamGridRunner`), decision-orchestrator funnel, sweep-designer / result-interpreter LLM contours, `RegimeLabeler`, office panels (Phase E), paper-candidate → platform 036 intake bridge (Phase D), Cycle 2 (paper improvement). Schema reserves forward-compatible columns for WFO but no WFO code is written.

---

## 1. Context & guarantee

trading-lab already runs a single-backtest research flow: `StrategyProfile → HypothesisProposal → HypothesisBuild → BacktestRun → Evaluation → verdict`. A single backtest on one period can overfit. This block adds the minimum that makes the guarantee:

> **No new strategy reaches PAPER_CANDIDATE without surviving an out-of-sample holdout it was never evaluated on.**

We do this with a 1-fold split (train + holdout) where the boundary `T` is chosen by **number of trades**, not calendar days (a low-frequency strategy's "last N days" holdout would contain 3–5 trades and yield a statistically meaningless verdict).

### Decisions taken (this design)

- **Boundary source = real trade timestamps.** The backtester emits a `trades` artifact whose rows carry `entryTs`/`exitTs` (epoch ms). The exact SDK paging contract (`readArtifact` / `getArtifactManifest` shape) is **to be verified in the plan** — today's lab seam (`BacktesterClientLike`) does not expose these methods; the adapter seam will be extended and a `RunTradesPort.getRunTrades` will hide the paging. We compute the true `T` from the real trade distribution (roadmap §2.5 verbatim), not a frequency approximation.
- **Data availability:** real, multi-trade, timestamped data exists on real backtester runs (VPS / golden). The demo/mock stack does not run the engine over the fixture (mock serves ~73 pre-recorded ops trades on a *different* surface, `/ops/trade-evidence`), so on demo the holdout split will not reach `minTradesHoldout` and the flow will correctly degrade to `INCONCLUSIVE` — this is expected behaviour, not a bug.
- **Replace, not flag-gate.** The **initial new-strategy validation** path routes through the Train/Holdout flow. The single-backtest *primitives* are unchanged: the handler-level `runPlatformBacktest` and `finalizeBacktestCompletion` keep serving the hypotheses / retry / Cycle-2 single-backtest path untouched. The experiment flow drives its sanity/train/holdout runs via the **lower-level** submit+poll helper (`runOverlayBacktest` in `src/research/run-backtest.ts`, which returns `runId` + outcome summary) and reuses the `backtests` repository to persist `BacktestRun` rows — so it never calls the void-returning handler-level `runPlatformBacktest` and there is no API mismatch (see §5.0).
- **Reuse the full-period run as sanity.** The existing full-period (as-authored) backtest becomes the experiment's `sanity` member and the trade-distribution source. Only 2 incremental runs (train, holdout) beyond what already happens.
- **New composite evaluator** (`evaluateExperiment`) renders the experiment verdict from train + holdout; the existing pure `evaluateBacktest` is untouched and reused per-member where useful.

---

## 2. Architecture

Plain TypeScript service on the existing `WorkflowRouter` — **no Mastra workflow** (Mastra is only used to build LLM agents; there are zero `createWorkflow`/`createStep` usages in `src/`). The flow emits `events.append(...)` audit events per phase like existing handlers.

```
new strategy (analyst → build, bundle_hash fixed)
  → ExperimentService.runNewStrategyValidation(...)
      create ResearchExperiment(type=new_strategy_validation, status=running)
      ├─ SANITY: full-period backtest  (= existing run, role='sanity')
      │     gate: executes? trades>0? metrics non-garbage?   FAIL → experiment FAIL (reject)
      │     (sanity is a GATE + trade-distribution source ONLY — never the edge verdict)
      ├─ getRunTrades(sanityRunId) → TradeRecord[]  (entryTs/exitTs)
      ├─ HoldoutBoundaryResolver.resolve(trades, fullPeriod, policy) → HoldoutBoundary
      │     mode=none (insufficient trades) / <30d (insufficient history) → finalize INCONCLUSIVE, no split
      │     low_confidence (holdout in [lowConf, min)) → continue train/holdout for evidence, verdict capped INCONCLUSIVE (never paper)
      │     viable → fix T (persisted on the experiment, once)
      ├─ TRAIN: backtest [from, T)  (role='train')  → evaluate per-member
      │     train FAIL → experiment FAIL/MODIFY (no holdout run)
      ├─ HOLDOUT: backtest [T, to]  (role='holdout', period.from=T = no-leakage)
      └─ evaluateExperiment(train, holdout, flags) → experiment_evaluation + verdict
            holdout PASS  → PAPER_CANDIDATE   (forbidden if lowConfidenceHoldout — see §6.4)
            holdout FAIL  → FAIL, reason='holdout_failed'  (train passed + holdout failed = overfit signal; NOT paper)
      update experiment(status=completed, verdict, aggregateMetrics, completedAt)
```

Components (all new unless noted):
- **Data:** `research_experiment`, `experiment_run_member`, `experiment_evaluation` tables; domain types; `ResearchExperimentRepository` (write) + read port; drizzle + in-memory adapters.
- **Holdout:** `HoldoutPolicy`, `HoldoutBoundary`, `TradeRecord`, `HoldoutBoundaryResolver` (pure), `RunTradesPort` + adapters.
- **Flow:** `ExperimentService` (orchestration), `evaluateExperiment` (composite evaluator).
- **Read-API:** `ExperimentReadPort`, `routes/experiments.ts`, DTO mappers.

---

## 3. Data model

Conventions mirrored from existing tables: application-generated **text** ids (no uuid/serial), **no foreign keys** (append-only logs; relationships are plain id columns + indexes), **no PG enums** (`text(...).$type<Union>()`), jsonb via `.notNull().$type<DomainType>()`, `timestamp(..., { withTimezone: true })` with `.defaultNow()` for created/updated and nullable (no default) for terminal timestamps. Migration generated by `drizzle-kit generate` → next file `0013_*.sql` (+ `meta/`); **do not** hand-write or hand-edit `meta/_journal.json`. Do **not** run `db:migrate` without a live Postgres.

### 3.1 `research_experiment`

| column | type | notes |
|---|---|---|
| `id` | text PK | app-generated |
| `experiment_key` | text | **idempotency key** — `sha256({v:1, strategyProfileId, buildId, bundleHash, datasetScopeHash, holdoutPolicyHash})`; uniqueIndex (see §3.4) |
| `experiment_type` | text `$type<ExperimentType>` | `new_strategy_validation` now; union reserves `paper_improvement \| walk_forward \| walk_forward_optimization \| robustness_suite \| regression_suite` |
| `strategy_profile_id` | text | |
| `hypothesis_id` | text? | nullable |
| `build_id` | text? | nullable |
| `bundle_hash` | text? | nullable |
| `objective` | text? | why this experiment was run |
| `dataset_scope` | jsonb `$type<DatasetScope>` | `{ datasetId, symbols[], timeframe, period:{from,to} }` (full period) |
| `holdout_policy` | jsonb `$type<HoldoutPolicy>` | persisted so each experiment records how it was split |
| `holdout_boundary` | jsonb? `$type<HoldoutBoundary>` | resolved boundary; **fixed once** at resolution; null until resolved |
| `parameter_grid` | jsonb? | **reserved (WFO/Phase B2), unused now** |
| `status` | text `$type<ExperimentStatus>` | `pending \| running \| completed \| failed \| cancelled` |
| `verdict` | text? `$type<ExperimentVerdict>` | `PASS \| FAIL \| MODIFY \| INCONCLUSIVE \| PAPER_CANDIDATE`; null until completed |
| `verdict_reason` | text? | e.g. `holdout_failed`, `low_confidence`, `insufficient_history`, `sanity_failed` |
| `aggregate_metrics` | jsonb? | summary blob (train/holdout deltas, pass flags) |
| `created_at` | timestamptz | defaultNow |
| `updated_at` | timestamptz | defaultNow |
| `completed_at` | timestamptz? | nullable |

Indexes: `uniqueIndex research_experiment_key_uq (experiment_key)`; `index research_experiment_profile_idx (strategy_profile_id)`; `index research_experiment_status_idx (status)`.

### 3.2 `experiment_run_member`

| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `experiment_id` | text | |
| `backtest_run_id` | text? | null until the run is persisted |
| `role` | text `$type<MemberRole>` | `sanity \| train \| holdout \| targeted \| regression` |
| `fold_id` | integer? | single-split: sanity=null, train/holdout=null (reserved for multi-fold) |
| `period_from` | timestamptz | |
| `period_to` | timestamptz | half-open semantics — see §6.5 |
| `symbols` | jsonb `$type<string[]>` | |
| `params_hash` | text | |
| `bundle_hash` | text | |
| `params` | jsonb? | **reserved (WFO `request.params`), unused now** |
| `oos` | boolean? | **reserved (WFO OOS marker), unused now**; for this block holdout is conceptually OOS but we do not aggregate on it |
| `trade_count` | integer? | **actual** trades in this member's run = per-member validity flag |
| `result_summary` | jsonb? `$type<MemberResultSummary>` | metrics + pass/fail snapshot |
| `created_at` | timestamptz | defaultNow |

Index: `index experiment_run_member_experiment_idx (experiment_id)`.

### 3.3 `experiment_evaluation`

| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `experiment_id` | text | |
| `evaluator_version` | text | |
| `raw_scores` | jsonb | |
| `flags` | jsonb `$type<ExperimentFlags>` | `{ lowConfidenceHoldout, overfit, fragility[], coverageWarnings[] }` |
| `verdict` | text `$type<ExperimentVerdict>` | |
| `verdict_reason` | text? | |
| `created_at` | timestamptz | defaultNow |

Index: `index experiment_evaluation_experiment_idx (experiment_id)`.

### 3.4 Idempotency

Idempotency lives in the deterministic **`experiment_key`** (service-computed), not a column-tuple unique index that would wrongly collide across different scope/period/policy. `datasetScopeHash` and `holdoutPolicyHash` are canonical-JSON sha256 of the respective objects. Re-validating the **same** bundle on a **different** period/dataset/policy yields a different key → a new experiment, honestly allowed. `ExperimentService.runNewStrategyValidation` first looks up by `experiment_key`; if an open/completed experiment exists it returns it (no duplicate runs). This mirrors the existing `resumeToken = sha256({...identity})` convention.

### 3.5 Domain types — `src/domain/research-experiment.ts`

Plain interfaces + string-literal unions, ISO-string timestamps in the domain (Date only inside DB rows), `null → undefined` at the repo boundary. The interface blocks below are a **shape sketch** (field names only, shorthand `;`-separated) — the implementation file declares full `field: Type` members. All ids/hashes/timestamps are `string`; numeric counts are `number`; optionals (`?`) are `T | undefined`.

```ts
export type ExperimentType =
  | 'new_strategy_validation' | 'paper_improvement'
  | 'walk_forward' | 'walk_forward_optimization'
  | 'robustness_suite' | 'regression_suite';
export type ExperimentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type MemberRole = 'sanity' | 'train' | 'holdout' | 'targeted' | 'regression';
export type ExperimentVerdict = 'PASS' | 'FAIL' | 'MODIFY' | 'INCONCLUSIVE' | 'PAPER_CANDIDATE';

export interface DatasetScope { datasetId: string; symbols: string[]; timeframe: string; period: { from: string; to: string }; }
export interface ResearchExperiment { id; experimentKey; experimentType; strategyProfileId; hypothesisId?; buildId?; bundleHash?; objective?; datasetScope; holdoutPolicy; holdoutBoundary?; status; verdict?; verdictReason?; aggregateMetrics?; createdAt; updatedAt; completedAt?; }
export interface ExperimentRunMember { id; experimentId; backtestRunId?; role: MemberRole; foldId?; periodFrom; periodTo; symbols: string[]; paramsHash; bundleHash; tradeCount?; resultSummary?; createdAt; }
export interface ExperimentEvaluation { id; experimentId; evaluatorVersion; rawScores; flags: ExperimentFlags; verdict: ExperimentVerdict; verdictReason?; createdAt; }
export interface ExperimentFlags { lowConfidenceHoldout: boolean; overfit: boolean; fragility: string[]; coverageWarnings: string[]; }
```

---

## 4. Holdout policy & boundary

### 4.1 Types

```ts
export interface HoldoutPolicy {
  mode: 'none' | 'time_based' | 'trade_based';   // 'trade_based' is the default for this block
  minTradesTrain: number;       // default 50
  minTradesHoldout: number;     // default 30
  lowConfidenceThreshold: number; // default 15
  minHistoryDays?: number;      // default 30 — below this → mode resolves to 'none'
}
export interface HoldoutBoundary {
  mode: 'none' | 'trade_based';
  t?: string;                   // ISO; the fixed split boundary (absent when mode='none')
  trainTrades?: number;         // sanity trades with entryTs <  T
  holdoutTrades?: number;       // sanity trades with entryTs >= T
  lowConfidence: boolean;       // holdoutTrades in [lowConfidenceThreshold, minTradesHoldout)
  reason?: 'insufficient_trades' | 'insufficient_history' | 'ok';
}
export interface TradeRecord { entryTs: number; exitTs: number; side: 'long' | 'short'; realizedPnl: number; }
```

`HoldoutPolicy` defaults: `{ mode:'trade_based', minTradesTrain:50, minTradesHoldout:30, lowConfidenceThreshold:15, minHistoryDays:30 }`.

### 4.2 `HoldoutBoundaryResolver.resolve(trades, period, policy)` — pure function

Membership rule: a trade belongs to the holdout iff it **enters at/after `T`** (the holdout run uses `period.from=T`, so the engine only produces trades entering in `[T, to]`). Therefore `T` is chosen on `entryTs`.

Algorithm:
1. If `period` span `< minHistoryDays` → `{ mode:'none', lowConfidence:false, reason:'insufficient_history' }`.
2. Sort `entryTs` ascending; `n = trades.length`.
3. Target holdout count `h = minTradesHoldout`. `T = entryTs[n - h]` (the h-th trade from the end) → exactly `h` trades have `entryTs >= T`; `trainTrades = n - h`.
   - If `trainTrades >= minTradesTrain` → `{ mode:'trade_based', t:T, trainTrades, holdoutTrades:h, lowConfidence:false, reason:'ok' }`.
4. Otherwise try the largest `h' < minTradesHoldout` with `h' >= lowConfidenceThreshold` such that `n - h' >= minTradesTrain`. If found → same but `lowConfidence:true`.
5. Otherwise → `{ mode:'none', lowConfidence:false, reason:'insufficient_trades' }` (cannot honour both minimums).

`T` is **fixed once** and persisted on `research_experiment.holdout_boundary`; it never moves within an experiment.

> Edge handling to cover in tests: ties on `entryTs` at the boundary (multiple trades share `T` — they all fall into holdout, so the realized `holdoutTrades` may exceed `h`; recompute counts from the chosen `T` rather than trusting the index); `n` exactly at minimums; `n=0`.

### 4.3 Trades port — `RunTradesPort`

The domain flow depends on a **port**, not the concrete adapter. A dedicated small port keeps `ResearchPlatformPort` focused and makes faking trivial.

```ts
export interface RunTradesPort {
  getRunTrades(runId: string): Promise<TradeRecord[]>;
}
```

`getRunTrades` takes **only `runId`** — the trades `artifactId` is an internal detail. Implementations:
- **`HttpBacktesterRunTradesAdapter`** (real): extend the `BacktesterClientLike` SDK seam in `http-backtester.adapter.ts` with `getArtifactManifest(runId)` + `readArtifact(runId, artifactId, {offset, limit})` (the concrete injected `BacktesterClient` already implements both). The adapter: `getArtifactManifest(runId)` → find descriptor with `artifactType === 'trades' && availability === 'available'` → page `readArtifact` (`offset`/`limit` + `nextCursor`) until `total` consumed → parse each row into `TradeRecord` (lab owns the parse; `ArtifactPage.page` is `unknown[]`). Rows missing `entryTs`/`exitTs` are rejected with a clear error.
- **Normalization note:** artifact refs appear in two shapes — object `ArtifactReference[]` in `RunResultView.summary.artifactRefs`, and `string[]` in `backtest_run.artifact_refs` (DB). The adapter does **not** rely on either; it re-derives the trades content-hash from `getArtifactManifest(runId)`, which is authoritative and run-scoped.
- **`MockRunTradesAdapter`** (demo/default): returns canned/empty trades (drives the `INCONCLUSIVE` degrade path).
- **`FakeRunTradesAdapter`** (tests): returns a caller-supplied `TradeRecord[]`.

Wired into `AppServices` and injected into `ExperimentService`.

---

## 5. Flow — `ExperimentService`

`runNewStrategyValidation(input)` where `input = { strategyProfile, hypothesis, build, bundle, datasetScope, holdoutPolicy }`. Plain class on `AppServices`, registered as a `WorkflowHandler` for the new-strategy path. Emits audit events (`*.started` / `*.completed` / `*.failed`) per phase.

### 5.0 Run execution helper (resolving the `runPlatformBacktest` mismatch)

The handler-level `runPlatformBacktest` returns `void` and mints the `backtestRunId` internally — unusable for a flow that needs the `runId` (to fetch trades) and the per-run summary. So `ExperimentService` does **not** call it. Instead it uses the **lower-level** submit+poll helper `runOverlayBacktest` (`src/research/run-backtest.ts`), which submits via `submitOverlayRun`, bounded-polls, and returns a `PlatformRunOutcome` carrying the `runId`, `status` (`completed | pending | rejected`), and `RunResultSummary`. `ExperimentService` then persists the `BacktestRun` row itself (reusing the `backtests` repository — `createSubmitted` / `markCompleted` / `markEvaluated`) and the `ExperimentRunMember` with the now-known `backtestRunId` and `tradeCount`. The handler-level `runPlatformBacktest` is left exactly as-is for the single-backtest path. (Plan must confirm `runOverlayBacktest`'s exact signature; if it does not surface `runId`/summary in the needed shape, add a thin `submitAndAwaitRun` wrapper around `submitOverlayRun` + `pollOverlayRun` — both already exist.)

1. Compute `experiment_key`; if an experiment exists → return it (idempotent).
2. `createExperiment({ status:'running', datasetScope, holdoutPolicy })`.
3. **Sanity** — submit a full-period backtest via the lower-level helper (§5.0) to obtain `{ runId, summary }`; persist the `BacktestRun` row + an `experiment_run_member{ role:'sanity', backtestRunId, periodFrom/To = full, paramsHash, bundleHash, tradeCount }`.
   - **Sanity is a gate + distribution source only**, never the edge verdict. Gate = executes ∧ `total_trades > 0` ∧ metrics non-garbage. Gate FAIL → `finalizeExperiment(verdict:'FAIL', reason:'sanity_failed')`. (Using the full-period *edge* for the verdict would leak the holdout window — forbidden; see §6.3.)
4. `getRunTrades(sanityRunId)` → `TradeRecord[]`.
5. `HoldoutBoundaryResolver.resolve(...)`:
   - `mode:'none'` (insufficient trades/history) → persist `holdout_boundary`, `finalizeExperiment(verdict:'INCONCLUSIVE', reason)` — **graceful degrade** (this is the demo path). No train/holdout runs.
   - `lowConfidence:true` → continue, but the verdict is capped at `INCONCLUSIVE` (see §6.4).
   - viable → persist `holdout_boundary` (T fixed).
6. **Train** — backtest `[from, T)` (half-open, §6.5) → `experiment_run_member{ role:'train', tradeCount }`; per-member `evaluateBacktest`.
   - train decision `FAIL` → `finalizeExperiment(verdict:'FAIL'|'MODIFY' per train decision)`; no holdout run.
7. **Holdout** — backtest `[T, to]` (`period.from=T`) → `experiment_run_member{ role:'holdout', tradeCount }`.
8. `evaluateExperiment(trainSummary, holdoutSummary, boundary, members)` → `experiment_evaluation` + verdict; `finalizeExperiment(...)`.

**Resumability:** each phase first checks for an existing member by `role` (skip re-running). If a backtest comes back `pending` (e.g. demo WSL2 nested-docker), the flow emits `*.pending` and returns; the existing SP-7.3 webhook/resume re-invokes the flow, which resumes from the first incomplete phase. Happy path (synchronous completion / mock canned result) is primary; the resume seam exists for correctness, full async robustness beyond the existing mechanism is out of scope.

**No-leakage invariant:** the holdout run is configured with `period.from=T`, and `T` is fixed in step 5 before train/holdout run. Train metrics never include `[T, to]`.

---

## 6. Evaluation & semantics

### 6.1 `evaluateExperiment(train, holdout, boundary, members)` — new composite evaluator

Pure function. Inputs are the train + holdout `ComparisonSummary` blocks (mapped via existing `mapPlatformComparison`), the resolved `HoldoutBoundary`, and the members (for trade counts). It may reuse `evaluateBacktest` per-summary internally for the per-window PASS/FAIL ladder, but the **experiment verdict is its own**:

- `holdout` survives (PASS-class on the holdout window) ∧ not lowConfidence → **`PAPER_CANDIDATE`**.
- `holdout` fails → **`FAIL`**, `reason:'holdout_failed'` (train passed, holdout failed = overfit signal). Sets `flags.overfit=true`. **Not paper.**
- `lowConfidence` holdout → **`INCONCLUSIVE`** with `flags.lowConfidenceHoldout=true` (§6.4) regardless of holdout pass.
- insufficient (never reached holdout) → **`INCONCLUSIVE`** (set in the flow, not here).

`evaluator_version` is stamped; thresholds frozen into `raw_scores` for audit (mirrors how `Evaluation` freezes thresholds).

### 6.2 `evaluateBacktest` untouched

The existing pure per-run evaluator and `finalizeBacktestCompletion` (one-run → one-Evaluation) are **not modified**. `ExperimentService` calls `evaluateBacktest` per member where it wants a per-window decision and composes the verdict itself. The single-backtest flow's contract is preserved (invariant: do not break single-backtest flow).

### 6.3 Sanity is a gate, not an edge

The full-period sanity run **includes the future holdout window**, so using its edge metrics for the experiment verdict would be leakage. Sanity contributes exactly two things: a boolean gate (executes / trades>0 / non-garbage) and the trade distribution for `T`. The edge verdict comes only from train + holdout.

### 6.4 Low-confidence → not paper (this block)

For this research-only 🟢 block, **`lowConfidenceHoldout=true` (or insufficient holdout) can never produce `PAPER_CANDIDATE`** — the verdict is capped at `INCONCLUSIVE`. The roadmap's "allow low-confidence with a flag, compensate with a longer paper period" requires the paper-period compensation mechanism, which is Cycle 2 / 🟡 scope and not built here. Safer default for a diploma research flow: collect more data, don't promote.

### 6.5 Period boundary encoding (no-leakage, half-open)

Domain convention: train `= [from, T)` (half-open), holdout `= [T, to]`. The bar at exactly `T` belongs to holdout only. Encoding on the wire depends on the backtester's `period.to` inclusivity:
- If `period.to` is **exclusive**, pass train `{from, to:T}` directly — naturally half-open.
- If `period.to` is **inclusive** at bar granularity, set train `to = T − one timeframe unit` so the `T` bar is not double-counted.

**Plan must include a verification task** to confirm the backtester's `period.to` semantics (read the engine's window filter) and pick the encoding; the resolver/flow centralizes it in one helper (`encodeTrainPeriod(from, T, timeframe)`).

---

## 7. Read-API (Hono)

Add under the existing `/v1` sub-app — gated by the existing `readAuthMiddleware(deps.token)` exactly like every other `/v1` route (no per-route auth; registering under `v1` inherits the bearer gate). List envelope `{ data, page:{ nextCursor, limit } }`; detail = bare DTO; error `{ error:{ code, message } }`.

- `ExperimentReadPort { list(q): Promise<ResearchExperiment[]>; getById(id): Promise<ResearchExperiment | null>; listRuns(experimentId): Promise<ExperimentRunMember[]>; }`
- `src/read-api/routes/experiments.ts` → `registerExperimentRoutes(app, deps)`:
  - `GET /v1/experiments` — list (filters: `strategyProfileId`, `status`, `limit`, `cursor`).
  - `GET /v1/experiments/:id` — detail (404 envelope if absent).
  - `GET /v1/experiments/:id/runs` — `deps.experiments.listRuns(c.req.param('id'))`.
- `dto.ts`: `ExperimentDto`, `ExperimentRunMemberDto`, `ExperimentListQuerySchema` (Zod). `mappers.ts`: `toExperimentDto`, `toExperimentRunMemberDto` — **null-preserving** (office mirrors DTOs and depends on null preservation).
- `read-app.ts`: `registerExperimentRoutes(v1, deps)` + add the 3 paths to `V1_PATHS` (for the explicit 405 on write verbs).
- `deps.ts`: `experiments: ExperimentReadPort`.
- Adapters: `DrizzleExperimentReadAdapter` + `InMemoryExperimentReadAdapter`.

---

## 8. Wiring

- `src/orchestrator/app-services.ts`: add `experiments: ResearchExperimentRepository`, `experimentService: ExperimentService`, `runTrades: RunTradesPort` to `AppServices`.
- `src/composition.ts::composeRuntime`: instantiate `new DrizzleResearchExperimentRepository(db)`, the `RunTradesPort` adapter (selected like `selectResearchPlatform`), `new ExperimentService({ ... })`, and `new DrizzleExperimentReadAdapter(db)` into the `read` bundle; route the new-strategy path to `ExperimentService`. **Reroute criterion:** only the *initial* new-strategy validation (the first build of a freshly-onboarded strategy profile) goes to `ExperimentService`; hypothesis retries and Cycle-2 paper-improvement builds keep the existing single-backtest path. The plan pins the exact discriminator at the call site (§12).
- Constructor convention: `constructor(deps){ this.x = deps.x }` — **no TS parameter-properties** (breaks under `node --experimental-strip-types`; enforced by `src/strip-types-no-param-properties.test.ts`).

---

## 9. Testing

**Unit (pure, fast):**
- `HoldoutBoundaryResolver`: trade_based happy path; low-confidence band `[15,30)`; `none` insufficient_trades; `none` insufficient_history (<30d); train-insufficient; boundary ties on `entryTs`; `n` at exact minimums; `n=0`.
- `evaluateExperiment`: train-PASS + holdout-FAIL → `FAIL`/`holdout_failed`, **not** PAPER_CANDIDATE, `overfit=true`; holdout-PASS → PAPER_CANDIDATE; lowConfidence → INCONCLUSIVE (even if holdout passes); train-FAIL short-circuit.
- `experiment_key` determinism (same inputs → same key; different scope/policy → different key).

**Integration:**
- Repository round-trip (DB-gated on `DATABASE_URL`); in-memory adapter parity.
- Read-API via Hono `app.request('/v1/experiments...')`: list envelope, detail, `:id/runs`, 404, 401 without bearer, 405 on write verbs.
- **Full flow** with a fake platform + `FakeRunTradesAdapter`: sanity → resolve T → train PASS → holdout FAIL → experiment verdict `FAIL`/`holdout_failed`, no PAPER_CANDIDATE; and the demo-degrade case (few trades → INCONCLUSIVE, no train/holdout runs).

**Gates before "done":** `pnpm typecheck` explicitly (Vitest can pass while `noUncheckedIndexedAccess` fails; `tsc` only covers `src/`); `pnpm test` full suite green; verify the single-backtest flow is unchanged (zero diff to `finalizeBacktestCompletion` / `evaluateBacktest` behaviour).

---

## 10. Build order (confirmation after each)

1. **Registry** — domain types, schema + migration `0013`, repository (port + drizzle + in-memory), read port + adapter, read-API routes/DTOs, wiring. Acceptance: experiments + members persist; `GET /v1/experiments[/:id][/runs]` work under bearer; existing flows unbroken.
2. **Holdout** — `HoldoutPolicy`/`HoldoutBoundary`/`TradeRecord`, `HoldoutBoundaryResolver` (pure + tests), `RunTradesPort` + http/mock/fake adapters (SDK seam extension), `period.to` semantics verification + `encodeTrainPeriod`.
3. **Flow** — `ExperimentService` (sanity→T→train→holdout, idempotent, resumable seam), `evaluateExperiment`, route the new-strategy path to it, integration tests.

---

## 11. Invariants & gotchas

1. **Holdout unit = trades, not days.** `T` fixed once from the sanity trade distribution; per-member `trade_count` is a validity flag, not a boundary shift.
2. **No leakage.** Holdout run uses `period.from=T`; `T` fixed before train/holdout; train metrics exclude `[T, to]`; sanity edge never feeds the verdict (§6.3).
3. **INCONCLUSIVE ≠ FAIL.** Too few trades / too little history is a coverage problem, not a strategy failure.
4. **Low-confidence / insufficient holdout → never PAPER_CANDIDATE** in this block (§6.4).
5. **Single-backtest flow untouched.** Handler-level `runPlatformBacktest`, `finalizeBacktestCompletion`, `evaluateBacktest` are **unmodified**; the experiment flow composes the lower-level submit+poll helper (§5.0) and reuses `evaluateBacktest` read-only.
6. **Idempotency via `experiment_key`**, not a column tuple — re-validation on a different scope/policy is allowed.
7. **Trades fetched via a port** (`RunTradesPort`), not a concrete adapter; `getRunTrades(runId)` hides the artifact id.
8. **strip-types:** no TS parameter-properties; run `pnpm typecheck` (not just Vitest).

---

## 12. Open items for the plan (not blockers)

- Confirm backtester `period.to` inclusivity → choose `encodeTrainPeriod` form (§6.5).
- Confirm the exact new-strategy call site to reroute to `ExperimentService` (where the current new-strategy hypothesis build triggers its single backtest) vs hypotheses/Cycle-2 which keep the single-backtest path.
- `symbols` column storage: `jsonb $type<string[]>` vs `text[]` — pick to match nearest existing precedent in `schema.ts`.
