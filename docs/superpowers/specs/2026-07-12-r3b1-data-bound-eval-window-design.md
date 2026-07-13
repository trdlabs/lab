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

### 3.1 Pure resolver
`resolveEvalPeriod(datasets: readonly DatasetDescriptor[], fallback: PlatformRunConfig): { runConfig: PlatformRunConfig; source: 'dataset' | 'fallback'; fallbackReason?: string }` — a pure function (no I/O, no clock). It:
- finds the dataset matching `fallback.datasetId` **and** `fallback.timeframe`;
- reads its `dateRange { from, to }`;
- **validates**: `from`/`to` parse as timestamps, `from < to`, dataset id + timeframe match;
- on success → `{ runConfig: { ...fallback, period: { from, to } }, source: 'dataset' }`;
- on any miss/invalid (no dataset, no `dateRange`, unparseable, `from >= to`) → `{ runConfig: fallback, source: 'fallback', fallbackReason: <'dataset_not_found'|'no_date_range'|'invalid_range'|'no_datasets'> }`.

The handler owns the I/O + events: it calls `services.researchPlatform.listDatasets()` (already used at `hypothesis-build:113`), passes the result to the pure resolver, and emits `eval_window.resolved { source, period }` or `eval_window.fallback { reason }` with the correct `task.id`.

### 3.2 `research-run-cycle` — resolve once, thread into every hypothesis.build
- The cycle's window is `payload.evalPlatformRun ?? (resolve via listDatasets)` — resolved **once** at the top of the handler (a retry inherits it, §3.3; a fresh cycle resolves it). On a fallback the handler emits `eval_window.fallback`.
- Every `hypothesis.build` enqueued (`:460`) carries this resolved config as its immutable `platformRun` payload (replacing `services.defaultPlatformRun`). So all hypotheses of the cycle share one window.

### 3.3 Retry inheritance (mirror the R4 `symbol` field)
- `ResearchRunCyclePayloadSchema` gains `evalPlatformRun?: <PlatformRunConfig shape>`.
- `enqueueResearchRetry` (`backtest-completed.handler`) carries `evalPlatformRun` exactly as it already carries `symbol`: `payload: { ..., ...(evalPlatformRun ? { evalPlatformRun } : {}) }`. The originating `evalPlatformRun` is threaded through `backtest.completed` (its schema gains `evalPlatformRun?`, populated where `symbol` is) so a FAIL/MODIFY retry researches the SAME window, never re-resolving to a shifted one.

### 3.4 `revision-build` — extract the canonical window from the cycle, don't re-resolve
- `revision-build` does NOT call `listDatasets()`. It already lists the correlation's `hypothesis.build` tasks (`:210`, `listByCorrelationAndTypes(cid, ['hypothesis.build'])`); read their `payload.platformRun` and use it as `runConfig` (replacing `services.defaultPlatformRun:326`).
- **Consistency gate:** if the correlation's hypothesis.build tasks carry more than one *distinct* `platformRun` window, do NOT silently mix — emit `eval_window.inconsistent { revisionId, windows }` and **reject** the revision (`verdictReason: 'eval_window_inconsistent'`). (Happy path: all identical, since one resolution seeds the whole cycle + retries inherit it — the gate is a defensive invariant.)
- **Fallback:** if no hypothesis.build task carries a `platformRun` (older tasks / absent), fall back to `services.defaultPlatformRun` + emit `eval_window.fallback { reason: 'no_cycle_window' }` (never abort).

### 3.5 Fail-soft + demo
No datasets / invalid range → `defaultPlatformRun` + observable `eval_window.fallback`. On the mock, `dateRange` is short / data is thin → R3a's `resolveHoldoutBoundary` returns `mode:'none'` (`insufficient_trades`) → the gate stays inert (honest), and binding never breaks the demo (fail-safe). The gate switches on automatically once the VPS dataset's `dateRange` spans ≥30 days with enough trades.

## 4. Data flow
```
research.run_cycle:
  window = payload.evalPlatformRun ?? resolveEvalPeriod(await listDatasets(), defaultPlatformRun).runConfig
    (fallback → eval_window.fallback; dataset → eval_window.resolved)
  → each hypothesis.build enqueued with platformRun = window (immutable)
  FAIL/MODIFY → enqueueResearchRetry carries evalPlatformRun = window  (retry inherits, no re-resolve)

revision.build (same correlation):
  windows = distinct platformRun of the correlation's hypothesis.build tasks
    0 → fallback defaultPlatformRun + eval_window.fallback{no_cycle_window}
    >1 distinct → eval_window.inconsistent + reject verdictReason='eval_window_inconsistent'
    1 → runConfig = that window  (→ R3a resolveHoldoutBoundary splits it)
```

## 5. Testing
- **resolveEvalPeriod** (unit, pure): dataset match → bound config `source:'dataset'`; no match → `fallback` + `dataset_not_found`; missing `dateRange` → `no_date_range`; unparseable / `from>=to` → `invalid_range`; empty datasets → `no_datasets`; timeframe mismatch → fallback.
- **research-run-cycle**: resolves once, every hypothesis.build enqueued with the bound `platformRun`; on `listDatasets` fallback → `eval_window.fallback` + hypotheses use `defaultPlatformRun`; a retry with `payload.evalPlatformRun` reuses it WITHOUT calling `listDatasets` again.
- **retry inheritance**: a FAIL/MODIFY retry `research.run_cycle` payload carries the originating `evalPlatformRun` (mirror the `symbol` back-compat + present tests).
- **revision-build**: single-window cycle → `runConfig` = that window (assert the executor ran on it); multi-window cycle → `eval_window.inconsistent` + revision rejected `eval_window_inconsistent`; no-window cycle → fallback + `eval_window.fallback`.
- **R3a interaction (unchanged tests green)**: a bound window long enough for a `trade_based` boundary → R3a gate runs on it; short demo window → `mode:'none'` inert.

## 6. Scope guard / deferred
- **R3b-2:** per-hypothesis train/holdout arbiter (extend the R3a gate to `hypothesis.build`/`evaluateBacktest`, all cycleDepth) — this slice binds the window only; the threaded window is what makes per-hypothesis T-splits consistent across the cycle.
- **R3c:** multi-fold WFA → consume backtester **E3**.
- Cycle-1 onboarding not bound (its holdout is `experiment-service`-side).
- Trailing-window cap on a very long `dateRange` (regime staleness) — out of scope; R3a's boundary handles the split, and a cap is a later tuning concern.

## 7. Invariants / gotchas
- The eval window is resolved **once per cycle** and threaded immutably; revision-build never re-resolves (reads the cycle's hypothesis.build window) — the cycle is reproducible.
- Retry inherits `evalPlatformRun` (like `symbol`) — a research pass never migrates to a different window mid-cycle.
- The consistency gate rejects rather than silently mixing windows.
- Resolver is pure (`{runConfig, source, fallbackReason?}`); only handlers do I/O + emit events with their own `task.id`.
- No new env var. `PlatformRunConfig` shape unchanged (only the `period` value becomes data-bound).
