# R3b-1 — data-bound Cycle-2 eval window (durable, threaded)

**Date:** 2026-07-12
**Status:** design approved (brainstorming), ready for writing-plans
**Source:** R3a spec §6 deferred (`docs/superpowers/specs/2026-07-12-r3a-revision-holdout-gate-design.md`); hypothesis-eval report R3 (M2 — static in-sample eval window). First slice of R3b.
**Boundary:** reconciliation §3 — single-fold, lab-side. Multi-fold WFA → backtester **E3** (R3c). Per-hypothesis train/holdout arbiter → **R3b-2** (this slice binds the window only).

## 1. Problem

The Cycle-2 eval window is the hardcoded fixture `defaultPlatformRun` (`composition.ts:453`, HUSDT:1m `2026-06-22..28`, seed 42), used verbatim at the period-choice sites (`research-run-cycle.handler:460` sets each `hypothesis.build` `platformRun`; `revision-build.handler:326` `runConfig`). So R3a's holdout gate is structurally present but **inert on real data** (it can only split a fixed 6-day fixture), and the cycle is not reproducible: nothing records the dataset snapshot the hypotheses were selected and merged on.

## 2. Goal (R3b-1)

The Cycle-2 eval window is derived **once** from the dataset's available range and threaded **durably** through the whole cycle, so (a) on VPS (~30d+) R3a's gate actually bites, and (b) the hypotheses and the merged revision are always evaluated on the **same** window (reproducible, no drift). Cycle 1 (onboarding: `strategy-baseline`/`strategy-wfo`/chat) is NOT bound here — it has its own holdout via `experiment-service`.

## 3. Design

### 3.0 Shared `PlatformRunConfigSchema`
The `PlatformRunConfig` Zod shape (`{ datasetId, symbols, timeframe, period: { from, to }, seed }`) is currently re-declared ad hoc. Extract it **once** (e.g. `src/orchestrator/handlers/platform-run-config.schema.ts`) and import it into every payload schema that carries an eval window — `ResearchRunCyclePayloadSchema.evalPlatformRun`, `BacktestCompletedPayload.evalPlatformRun`, and any retry payload — so the three sites never drift. No behavior change; a pure de-duplication that this slice depends on.

### 3.1 Pure resolver
`resolveEvalPeriod(datasets: readonly DatasetDescriptor[], fallback: PlatformRunConfig): { runConfig: PlatformRunConfig; source: 'dataset' | 'fallback'; fallbackReason?: string }` — a pure function (no I/O, no clock, **never throws**). It:
- finds the dataset matching `fallback.datasetId` **and** `fallback.timeframe`;
- reads its `dateRange { from, to }`;
- **validates**: `from`/`to` parse as timestamps, `from < to`, dataset id + timeframe match;
- on success → `{ runConfig: { ...fallback, period: { from, to } }, source: 'dataset' }`;
- on any miss/invalid (no dataset, no `dateRange`, unparseable, `from >= to`) → `{ runConfig: fallback, source: 'fallback', fallbackReason: <'dataset_not_found'|'no_date_range'|'invalid_range'|'no_datasets'> }`.

The handler owns the I/O + events. It wraps the discovery call in try/catch: `services.researchPlatform.listDatasets()` (already used at `hypothesis-build:113`). On a **thrown** discovery error it does NOT call the resolver — it emits `eval_window.fallback { reason: 'dataset_discovery_failed' }` and uses `defaultPlatformRun` directly (the resolver only ever sees a successfully-returned dataset list). On a returned list it passes the result to the pure resolver and emits `eval_window.resolved { source, period }` or `eval_window.fallback { reason }` with the correct `task.id`. So `dataset_discovery_failed` is a **handler-emitted** reason (transport threw); the resolver's four reasons cover a returned-but-unusable list.

### 3.2 `research-run-cycle` — resolve once, thread into every hypothesis.build
- The cycle's window is `payload.evalPlatformRun ?? (resolve via listDatasets)` — resolved **once** at the top of the handler (a retry inherits it, §3.3; a fresh cycle resolves it). On a fallback the handler emits `eval_window.fallback`.
- Every `hypothesis.build` enqueued (`:460`) carries this resolved config as its immutable `platformRun` payload (replacing `services.defaultPlatformRun`). So all hypotheses of the cycle share one window.

### 3.3 Retry inheritance (mirror the R4 `symbol` field)
- `ResearchRunCyclePayloadSchema` gains `evalPlatformRun?: PlatformRunConfigSchema` (the §3.0 shared shape).
- `enqueueResearchRetry` (`backtest-completed.handler`) carries `evalPlatformRun` exactly as it already carries `symbol`: `payload: { ..., ...(evalPlatformRun ? { evalPlatformRun } : {}) }`. The originating `evalPlatformRun` is threaded through the `backtest.completed` payload (`BacktestCompletedPayload` gains `evalPlatformRun?`, extracted alongside `symbol` at `backtest-completed.handler:86` and passed at both retry call sites `:113`/`:136`) so a FAIL/MODIFY retry researches the SAME window, never re-resolving to a shifted one.

**Both `backtest.completed` producers source the window from the persisted run — not a re-resolve.** The full config is already persisted as `BacktestRun.platformRun` (`run-platform-backtest.ts:76`), so:
- **submit** (`runPlatformBacktest`): `enqueueBacktestCompleted(..., { ..., evalPlatformRun: again.platformRun })` (`:102`, `again` is the `findById` race-guard read that already sources `platformRunId`);
- **resume** (`resumePlatformRun`): `enqueueBacktestCompleted(..., { ..., evalPlatformRun: run.platformRun })` (`:57`, the persisted run object);
- **back-compat:** `evalPlatformRun?` is optional on `enqueueBacktestCompleted`'s args and on the payload — an in-flight `backtest.completed` task enqueued before this field existed simply omits it, and the retry falls back to re-resolving (identical to today). Both producers set it going forward.

### 3.4 `revision-build` — extract the canonical window from the cycle, don't re-resolve
- `revision-build` does NOT call `listDatasets()`. It already lists the correlation's `hypothesis.build` tasks (`:210`, `listByCorrelationAndTypes(cid, ['hypothesis.build'])`); read their `payload.platformRun` and use it as `runConfig` (replacing `services.defaultPlatformRun:326`).
- **`distinct` definition:** two windows are the same iff their **whole** `PlatformRunConfig` is equal — `datasetId`, `symbols`, `timeframe`, `period`, `seed` — not just `period`. Compare via the project's canonical `stableStringify` (`backtest-support.ts:29`, key-sorted, array-order-preserving), NOT `JSON.stringify` (key-order-sensitive). `distinct = new Set(configs.map(stableStringify))`.
- **Consistency gate — ordering.** The cycle windows are read early (at `:210`, well before the revision exists), but a `revisionId` for the reject event/verdict only exists after the candidate revision is created (~Step 7), and the executor runs later (~Step 8). So: compute the window set early; if `distinct.size > 1`, still create the candidate revision (giving a real `revisionId`), then — **before the executor is invoked** — transition it to `rejected` with `verdictReason: 'eval_window_inconsistent'` and emit `eval_window.inconsistent { revisionId, windows }`. The executor is **never called** on an inconsistent cycle (no wasted platform run). (Happy path: `distinct.size === 1`, since one resolution seeds the whole cycle + retries inherit it — the gate is a defensive invariant.)
- **Fallback:** if no hypothesis.build task carries a `platformRun` (older tasks / absent), fall back to `services.defaultPlatformRun` + emit `eval_window.fallback { reason: 'no_cycle_window' }` (never abort).

### 3.5 Fail-soft + demo
No datasets / invalid range → `defaultPlatformRun` + observable `eval_window.fallback`. On the mock, `dateRange` is short / data is thin → R3a's `resolveHoldoutBoundary` returns `mode:'none'` (`insufficient_trades`) → the gate stays inert (honest), and binding never breaks the demo (fail-safe). The gate switches on automatically once the VPS dataset's `dateRange` spans ≥30 days with enough trades.

## 4. Data flow
```
research.run_cycle:
  window = payload.evalPlatformRun ?? (try listDatasets() → resolveEvalPeriod(list, defaultPlatformRun).runConfig)
    listDatasets() throws → eval_window.fallback{dataset_discovery_failed} + defaultPlatformRun
    resolver source 'fallback' → eval_window.fallback{dataset_not_found|no_date_range|invalid_range|no_datasets}
    resolver source 'dataset'  → eval_window.resolved
  → each hypothesis.build enqueued with platformRun = window (immutable)
  FAIL/MODIFY → backtest.completed carries evalPlatformRun = run.platformRun
             → enqueueResearchRetry carries it  (retry inherits, no re-resolve)

revision.build (same correlation):
  configs = correlation's hypothesis.build tasks' payload.platformRun
  distinct = new Set(configs.map(stableStringify))   // whole config, not just period
    0 configs → fallback defaultPlatformRun + eval_window.fallback{no_cycle_window}
    distinct.size > 1 → create candidate revision → reject it verdictReason='eval_window_inconsistent'
                        + eval_window.inconsistent  (executor NOT called)
    distinct.size === 1 → runConfig = that window  (→ R3a resolveHoldoutBoundary splits it)
```

## 5. Testing
- **resolveEvalPeriod** (unit, pure): dataset match → bound config `source:'dataset'`; no match → `fallback` + `dataset_not_found`; missing `dateRange` → `no_date_range`; unparseable / `from>=to` → `invalid_range`; empty datasets → `no_datasets`; timeframe mismatch → fallback. Assert the resolver **never throws** on any of these inputs.
- **research-run-cycle**: resolves once, every hypothesis.build enqueued with the bound `platformRun`; on a resolver `fallback` → `eval_window.fallback{reason}` + hypotheses use `defaultPlatformRun`; **`listDatasets` throws → `eval_window.fallback{dataset_discovery_failed}`** + hypotheses use `defaultPlatformRun` (resolver not consulted); a retry with `payload.evalPlatformRun` reuses it WITHOUT calling `listDatasets` again.
- **retry inheritance (both producers)**: a completed submit run and a completed resume run each put `evalPlatformRun = run.platformRun` on `backtest.completed`; a FAIL/MODIFY retry `research.run_cycle` payload carries it (mirror the `symbol` back-compat + present tests); an old `backtest.completed` task without the field → retry omits it (back-compat, re-resolves as today).
- **revision-build**: single-window cycle → `runConfig` = that window (assert the executor ran on it); **multi-window cycle → candidate revision is created then rejected `eval_window_inconsistent` + `eval_window.inconsistent`, and the executor is NOT invoked** (assert no platform run); `distinct` compares the whole config (two tasks differing only in `seed` count as inconsistent); no-window cycle → fallback + `eval_window.fallback{no_cycle_window}`.
- **R3a interaction (unchanged tests green)**: a bound window long enough for a `trade_based` boundary → R3a gate runs on it; short demo window → `mode:'none'` inert.

## 6. Scope guard / deferred
- **R3b-2:** per-hypothesis train/holdout arbiter (extend the R3a gate to `hypothesis.build`/`evaluateBacktest`, all cycleDepth) — this slice binds the window only; the threaded window is what makes per-hypothesis T-splits consistent across the cycle.
- **R3c:** multi-fold WFA → consume backtester **E3**.
- Cycle-1 onboarding not bound (its holdout is `experiment-service`-side).
- Trailing-window cap on a very long `dateRange` (regime staleness) — out of scope; R3a's boundary handles the split, and a cap is a later tuning concern.

## 7. Invariants / gotchas
- The eval window is resolved **once per cycle** and threaded immutably; revision-build never re-resolves (reads the cycle's hypothesis.build window) — the cycle is reproducible.
- Retry inherits `evalPlatformRun` (like `symbol`) — a research pass never migrates to a different window mid-cycle.
- The consistency gate rejects rather than silently mixing windows, and compares the **whole** config via `stableStringify` (not `period` alone, not `JSON.stringify`). The reject runs on a created candidate revision (so a `revisionId` exists) but before the executor — no platform run is spent on an inconsistent cycle.
- Resolver is pure and **never throws** (`{runConfig, source, fallbackReason?}`); only handlers do I/O + emit events with their own `task.id`. A thrown `listDatasets()` is caught by the handler → `dataset_discovery_failed` fallback (the resolver is never handed a failure).
- The eval window is persisted on `BacktestRun.platformRun`; both `backtest.completed` producers (submit + resume) source `evalPlatformRun` from there — no re-resolution on the retry edge.
- No new env var. `PlatformRunConfig` shape unchanged (only the `period` value becomes data-bound). The shape is declared once (`PlatformRunConfigSchema`, §3.0) and shared across the three payload schemas.
