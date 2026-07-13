# R3a — OOS holdout gate for merged revisions (Cycle 2)

**Date:** 2026-07-12
**Status:** design approved (brainstorming), ready for writing-plans
**Source:** `docs/research/2026-07-11-hypothesis-evaluation-workflow-review.md` R3 (closes M2/M3/M6 — the ratchet-overfit hole). First slice of a decomposed R3.
**Boundary:** `docs/research/2026-07-12-backtester-phase-e-lab-reconciliation.md` §3 — single-fold holdout is lab-side; multi-fold WFA delegates to backtester **E3** (deferred, R3c). This slice builds NO multi-fold machinery.

## 1. Problem (M3 ratchet)

A merged revision (`revision-build.handler.ts`) is accepted on the **same** window that selected it: the greedy candidate loop runs baseline + candidate on `services.defaultPlatformRun` (the full, static fixture window, `:323`) and `evaluateRevision` decides ACCEPT in-sample. So a revision that overfits the eval window ratchets straight into `activeOverlayRules`. There is no out-of-sample confirmation, even though the boundary machinery (`resolveHoldoutBoundary`, PR #119) exists and is used for Cycle-1 baselines (`experiment-service.ts:175/297/450`) — just never for Cycle 2.

## 2. Goal (this slice — R3a)

A merged revision is ACCEPTed only after it also holds up on a holdout window the selection never saw. Concretely: split the eval window at a trade-count boundary `T`; run the greedy **selection on train `[from..T)`**; before final ACCEPT, run a **confirming pass on holdout `[T..to)`** and gate on it. Persist train + holdout metrics.

**Explicitly deferred (R3b/R3c):** binding the eval window itself to available history (still `defaultPlatformRun` here); per-hypothesis holdout (all cycleDepth); full A/B/C targeted/regression gates; multi-fold (→ E3).

## 3. Design

### 3.1 Boundary
Reuse `resolveHoldoutBoundary(baselineTrades, runConfig.period, policy)` where `policy = DEFAULT_HOLDOUT_POLICY` (`domain/research-experiment.ts:33`; `minTradesTrain:50, minTradesHoldout, minHistoryDays:30`). `baselineTrades` = trades of a **full-window** baseline run (the existing `comparison_baseline` run in this handler stays on `runConfig.period` for this purpose; `getRunTrades(baselinePlatformRunId)` — the R2 seam). `T` is computed once and fixed for the revision (mirrors §2.5 "T fixed from baseline for the whole experiment"). The full-window baseline run is used ONLY to derive `T` (its metrics are not the selection comparison — selection compares within the train window, §3.2.1); this trades one extra run for a non-circular boundary.

**Period encoding (mandatory):** never hand-write `{ from, to: T }`. Use `encodeTrainPeriod(from, T, timeframe)` and `encodeHoldoutPeriod(T, to)` from `src/research/period-encoding.ts` (the same helpers Cycle 1 uses, `experiment-service.ts:180/187/558/606`). They encapsulate the `PERIOD_TO_INCLUSIVE` boundary handling so train/holdout neither overlap nor gap at T.

**Boundary fetch failure (observable fail-soft):** the boundary needs `getRunTrades(fullBaselinePlatformRunId)`. If that throws, the gate must NOT silently vanish — stamp `holdoutValidation = { mode: 'none', reason: 'boundary_unavailable' }`, emit `revision.holdout_skipped { revisionId, reason: 'boundary_unavailable' }`, and proceed on the current full-window selection (R2-analog fail-soft, but observable). Same terminal shape as `mode:'none'`.

### 3.2 Two regimes on the boundary result
- **`mode: 'none'`** (`resolveHoldoutBoundary` returned no boundary — either `reason:'insufficient_history'` when span `< minHistoryDays`, e.g. the 6-day demo fixture, or `reason:'insufficient_trades'` when no valid split satisfies the policy): the gate is structurally inert. Keep the current full-window selection + ACCEPT, but stamp `holdoutValidation.mode:'none'` with the normalized reason (`skipped_insufficient_history` / `skipped_insufficient_trades`) and emit `revision.holdout_skipped`. Cycle 2 does not stall on short/thin data (matches the R2 empty-trades inert pattern, and INCONCLUSIVE≠FAIL); the gate switches on automatically once ≥30 days of history + enough trades accumulate (VPS).
- **`mode: 'trade_based'` (T resolved):** applies the gate regardless of `boundary.lowConfidence` — a low-confidence boundary (holdout in `[lowConfidenceThreshold, minTradesHoldout)`) STILL runs the holdout gate; the `lowConfidence: true` flag is only recorded in `holdoutValidation` + the event, never a reason to skip.
  1. **Selection on train.** The greedy candidate loop runs a **train baseline** and each candidate with `run = { ...runConfig, period: encodeTrainPeriod(runConfig.period.from, T, runConfig.timeframe) }`. `evaluateRevision(accepted = trainBaselineMetrics, candidate = candidateTrainMetrics)` + the R2 preservation veto decide ACCEPT-on-train over the train window only. **`trainBaselineMetrics`/`trainBaselinePlatformRunId` are computed on the train period — NOT the full-window `baselineMetrics` (§3.1), which is used only to derive T.** R2's `getRunTrades` for the veto reads the train baseline/candidate runs (same-window).
  2. **Holdout confirmation.** For the train-accepted candidate, run the candidate bundle **and** a holdout baseline on `run = { ...runConfig, period: encodeHoldoutPeriod(T, runConfig.period.to) }`; evaluate with `evaluateRevision(accepted = holdoutBaselineMetrics, candidate = candidateHoldoutMetrics)`.
  3. **Gate.** Holdout verdict `ACCEPT` → final ACCEPT. Holdout verdict NOT `ACCEPT` → **reject the revision** with `verdictReason: 'holdout_failed'`; the revision is not merged, `activeOverlayRules` unchanged. This is the M3 fix: acceptance requires non-degradation on a window the selection never saw.

### 3.3 Composition with R2 (trade-preservation)
Both are downgrade gates before ACCEPT and compose in order: (R2) trade-preservation veto on the **train** selection run → (R3a) holdout confirmation. A candidate must survive both to be accepted. R2's `applyRevisionPreservationGate` is unchanged; it now runs against train trades (same seam).

### 3.4 Persistence (ledger)
Add `holdoutValidation?: HoldoutValidation` to `StrategyRevision` (+ nullable additive migration on `strategy_revision`), where:
```
type HoldoutValidationReason =
  | 'skipped_insufficient_history'   // boundary mode:'none', reason:'insufficient_history'
  | 'skipped_insufficient_trades'    // boundary mode:'none', reason:'insufficient_trades'
  | 'boundary_unavailable'           // getRunTrades threw — gate skipped, observable
  | 'holdout_passed'
  | 'holdout_failed';

interface HoldoutValidation {
  mode: 'none' | 'trade_based';
  t?: string;                       // ISO boundary, when trade_based
  reason: HoldoutValidationReason;
  lowConfidence?: boolean;          // from HoldoutBoundary (trade_based low-confidence — gate still applies)
  trainMetrics?: BacktestMetricBlock;
  holdoutMetrics?: BacktestMetricBlock;
}
```
The interface lives in `domain/strategy-revision.ts`. Normalize the boundary's own `reason` (`'insufficient_history' | 'insufficient_trades' | 'ok'`) into the `mode:'none'` cases: `insufficient_history → skipped_insufficient_history`, `insufficient_trades → skipped_insufficient_trades`.

Emit `revision.holdout_validated { revisionId, mode, t?, decision, trainMetrics?, holdoutMetrics? }` on the pass and the `holdout_failed` reject; `revision.holdout_skipped { revisionId, reason }` on `mode:'none'`/`boundary_unavailable`.

**Primary accepted run-context (holdout PASS):** the holdout run is the FINAL acceptance arbiter, so on a passing gate set the revision's `metrics` and `comboBacktestRunId` to the **holdout** candidate run (not the train run). Both `trainMetrics` and `holdoutMetrics` are preserved in `holdoutValidation`. This keeps downstream consumers (G3b consolidation reads `comboBacktestRunId → platformRun` for its run-context; the paper bridge) pointing at the window the revision was actually accepted on. In the `mode:'none'`/`boundary_unavailable` paths, `metrics`/`comboBacktestRunId` stay the full-window accepted run as today.

**Repo/migration surface (for the plan):** `HoldoutValidation` type on `domain/strategy-revision.ts`; nullable additive column `holdout_validation jsonb` via a new `migrations/` file + `db/schema.ts`; map it in the drizzle `strategy-revision.repository.ts` (`create` + `toDomain`) AND the in-memory repository (the whitelist-drop that bit 7cb7a8d in R2 1a — cover with a round-trip test); `updateStatus` patch accepts `holdoutValidation`.

## 4. Data flow
```
accepted revision → revision.build
  full-window baseline run → getRunTrades(fullBaselinePlatformRunId)
    throws          → holdoutValidation{mode:'none', reason:'boundary_unavailable'} + revision.holdout_skipped
                       → full-window selection + ACCEPT (fail-soft)
    ok → resolveHoldoutBoundary(trades, runConfig.period, DEFAULT_HOLDOUT_POLICY) → boundary
  mode:'none'      → full-window selection + ACCEPT, holdoutValidation{mode:'none', reason:'skipped_insufficient_history'}
  mode:'trade_based' (T; lowConfidence flag recorded, gate still applies):
    selection: trainBaseline + candidate on encodeTrainPeriod(from,T,tf)   (evaluateRevision + R2 veto) → train-accepted
    confirm:   holdoutBaseline + candidate on encodeHoldoutPeriod(T,to)     (evaluateRevision)
      holdout ACCEPT      → final ACCEPT; metrics/comboBacktestRunId = HOLDOUT candidate run;
                            holdoutValidation{reason:'holdout_passed', lowConfidence?, trainMetrics, holdoutMetrics}
      holdout NOT ACCEPT  → reject verdictReason='holdout_failed';
                            holdoutValidation{reason:'holdout_failed', trainMetrics, holdoutMetrics}
```

## 5. Testing
- **boundary=none** (short fixture window → `insufficient_history`; and a separate thin-trades case → `insufficient_trades`): revision ACCEPTs as today; `holdoutValidation.mode==='none'` with the normalized `reason` (`skipped_insufficient_history` / `skipped_insufficient_trades`); `revision.holdout_skipped` emitted; no holdout run.
- **trade_based, holdout PASS**: selection runs on `[from..T)`; a holdout run on `[T..to)`; revision ACCEPTed; `holdoutValidation.reason==='holdout_passed'` with train+holdout metrics; `revision.holdout_validated` emitted.
- **trade_based, holdout FAIL**: train-accepted candidate degrades on holdout → revision rejected, `verdictReason==='holdout_failed'`, NOT merged, `activeOverlayRules` unchanged, event emitted.
- **same-run-context**: baseline and candidate holdout runs use the identical `[T..to)` period/seed/dataset.
- **R2 composition**: a train-run preservation veto still downgrades before the holdout stage is reached (holdout not run for a train-rejected candidate).
- **boundary fetch failure**: `getRunTrades(fullBaselinePlatformRunId)` throws → `holdoutValidation.reason==='boundary_unavailable'`, `revision.holdout_skipped` emitted, revision still ACCEPTs on the full-window selection (gate doesn't silently vanish).
- **lowConfidence gate applies**: a `mode:'trade_based'` boundary with `lowConfidence:true` still runs the holdout gate; the flag is recorded in `holdoutValidation`/event and does not skip the gate.
- **primary run-context on PASS**: after holdout PASS, `revision.metrics`/`comboBacktestRunId` point at the holdout candidate run; `holdoutValidation.trainMetrics`/`holdoutMetrics` both populated.
- **train/holdout period encoding**: selection/confirm runs use `encodeTrainPeriod`/`encodeHoldoutPeriod` (not hand-written `{from,to:T}`).
- **repo round-trip**: `holdoutValidation` survives create/findById on BOTH the drizzle and in-memory revision repositories (guards the R2-1a whitelist-drop class of bug).
- **fresh-profile / no baseline**: unchanged skip path (`no_baseline`).

## 6. Deferred (not R3a)
- **R3b:** bind the eval window to available history (not the fixture); per-hypothesis holdout (all cycleDepth).
- **R3c:** full A/B/C targeted/regression gates; multi-fold WFA → consume backtester **E3** (split as a request parameter).
- Run-cost: R3a adds the holdout confirmation runs (baseline + accepted candidate on `[T..to)`); acceptable for a data-gated gate that is inert until ≥30 days. A later optimization could derive holdout metrics by splitting full-run trades at T, but that would re-implement platform metric semantics in lab — out of scope; re-running keeps `evaluateRevision` semantics identical to everywhere else.

## 7. Invariants / gotchas
- `T` is computed once from the baseline full-window trades and fixed for the revision (params can shift trade distribution; a per-candidate boundary would make candidates incomparable — §2.5).
- Holdout gate is downgrade-only: it can turn a train-ACCEPT into a reject, never an accept.
- `mode:'none'` must not stall the loop — ACCEPT proceeds with the flag.
- No new env var; `DEFAULT_HOLDOUT_POLICY` is the policy source (same as Cycle 1). Selection-window change is internal to `revision-build`.
