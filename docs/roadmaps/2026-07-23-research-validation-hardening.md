# Research validation hardening — lab-local roadmap entry (2026-07-23)

Canonical cross-repo status lives in the control-center
[initiative registry](../../../control-center/docs/delivery/cross-repo-initiatives.md)
and the
[research-validation-hardening card](../../../control-center/docs/delivery/initiatives/research-validation-hardening.md);
this file keeps only lab's local slice (registry rule: no plan duplication).

Full analysis: control-center
[`docs/analysis/13-backtesting-validation-audit.md`](../../../control-center/docs/analysis/13-backtesting-validation-audit.md)
(gaps G1–G3, G11–G13; recommendations R1–R3, R11–R13).

## Lab's part — `proposed`

Principle for every item: the verdict stays with deterministic versioned code
(the existing ladder culture); the LLM proposes and diagnoses, never judges.

- **R2 (lab side) — done.** `evaluateStrategyBaseline`
  (`src/validation/strategy-baseline-evaluator.ts`) now computes
  `oosSharpe/isSharpe` and `oosPF/isPF` into `rawScores.oosDegradation` on
  every evaluation row (both the baseline and WFO-holdout lanes), and sets an
  informational `oos_degradation` fragility flag below a preliminary 0.5
  ratio. Log-mode only — the verdict ladder itself is unchanged; enforcement
  is deferred to a calibrated wave after item 7's SSOT threshold pinning. See
  the
  [research-validation-hardening card](../../../control-center/docs/delivery/initiatives/research-validation-hardening.md).
- **R1 (lab side) — done.** The lab port `RunResultSummary`
  (`src/ports/research-run-lifecycle.ts`) now carries an optional
  `trialContext: TrialContext` (byte-identical shape to the backtester SDK's
  advisory E2 projection), threaded passthrough from
  `HttpBacktesterAdapter.getRunResult` through
  `BacktesterStrategyExperimentRunExecutor`'s `StrategyExperimentRunResult`
  and persisted onto `experiment_evaluation.trial_context` (new nullable
  jsonb column, migration 0027, no backfill) from the holdout-lane result in
  both `runStrategyBaselineValidation` and `runWalkForwardOptimization`. DSR
  is now available to the ladders — the ladders themselves still don't read
  it (later items). See the
  [research-validation-hardening card](../../../control-center/docs/delivery/initiatives/research-validation-hardening.md).
- **R1 (consumer side)**: persist `RunResultSummary.trialContext`
  (trialCount, deflatedSharpe — already in the backtester SDK contract,
  advisory) into `experiment_evaluation`, so DSR becomes available to the
  ladders.
- **R2 — IS→OOS degradation**: compute `oosSharpe/isSharpe`, `oosPF/isPF` in
  the holdout evaluation and add an `oos_degradation` rung to the ladder in
  `src/validation/strategy-baseline-evaluator.ts` (today's floors —
  `sharpe > 0 ∧ PF ≥ 1` — pass a strategy whose OOS collapsed vs IS).
  Log-mode first, enforce after calibration.
- **R3 (lab side) — done.** `rankTopN`
  (`src/research/top-n-prefilter.ts`) now computes a deterministic axial
  (Von-Neumann) neighbor-sharpe-median per candidate against the FULL grid,
  flags `lonePeak: true` below a preliminary 0.5 neighbor-ratio (points with
  <2 valid neighbors get `plateauEvidence: 'insufficient_neighbors'` and are
  never penalized), and demotes lone peaks in rank right after the existing
  `lowConfidence` key. The flag survives `scrubMetricsBag` and is surfaced to
  the result-interpreter as an explicit "lone peak" prompt fact
  (`src/adapters/wfo/mastra-result-interpreter.ts`) — informational only, the
  LLM never decides on it. See the
  [research-validation-hardening card](../../../control-center/docs/delivery/initiatives/research-validation-hardening.md).
- **R3 — plateau analysis**: in `src/research/top-n-prefilter.ts::rankTopN`,
  a deterministic neighbour-cell stability metric per grid point; lone peak →
  `lone_peak` flag, rank lowered; flag surfaced to the result-interpreter as
  a fact.
- **R11 (log-mode) — done.** `break_battery@1`
  (`src/research/break-battery.ts`) now runs as a deterministic stage inside
  `runWalkForwardOptimization`, after the holdout evaluation and before
  `strategy-wfo.handler` enqueues `paper.start`: three versioned checks over
  the champion — DSR floor from the R1 `trialContext`, IS→OOS degradation
  over the same inputs as the R2 metric, and the R3 lone-peak/plateau
  evidence of the selected grid point — each with a `break_battery.*` reason
  code and severity. Flag `LAB_BREAK_BATTERY_MODE`: `off` (default — the
  battery is never invoked) → `log` (report persisted to
  `aggregateMetrics.breakBattery` + structural `break_battery.completed`
  event; verdict/status/timings are NEVER touched). `enforce` is rejected at
  boot until calibration completes — the floors are pinned by owner decision
  2026-07-24 as `battery-policy@1` (SSOT: control-center
  `docs/architecture/battery-policy.md`): DSR floor 0.95 (Bailey/López de
  Prado canonical confidence; `deflatedSharpe` is the DSR probability),
  IS→OOS ratio floor 0.5 (Pardo walk-forward efficiency), plateau =
  neighbor-median ≥ 0.5×peak (R3 semantics). Log-run calibration precedes
  any enforce flip (item 7 tail).
  Battery feedback toward the retry cycle exists only pre-sanitized through
  the Outcome-Embargo allowlist (`buildBreakBatteryRetryFeedback` →
  `sanitizeRetryFeedback`; the three failure codes are allowlisted in
  `outcome-embargo.ts`). Staging runs on the T2 fixture are a separate
  operator tail (needs mock-platform on staging).
- **R11 — break-the-result battery**: a new pipeline stage between the WFO
  verdict and `paper.start` — versioned deterministic checks over the
  champion (DSR/PSR floor → OOS degradation → plateau; later bootstrap-CI and
  stress windows), reason codes `break_battery.*`; failure → MODIFY/FAIL with
  feedback routed through the existing Outcome-Embargo sanitizer
  (`sanitizeRetryFeedback`). Mode flag `LAB_BREAK_BATTERY_MODE`
  (`off → log → enforce`, E4b-style rollout).
- **R12 — hypothesis-cycle hardening**: today a hypothesis verdict is one
  in-sample overlay run with delta thresholds and `PAPER_CANDIDATE` at the
  hypothesis level is explicitly a proxy
  (`backtest-completed.handler.ts`). Add (a) a lightweight holdout
  confirmation of the proxy status (flag `LAB_HYPOTHESIS_HOLDOUT`), and
  (b) register every hypothesis as a family trial in the backtester trial
  ledger so FAIL/MODIFY retries and many-hypotheses selection get discounted
  via DSR automatically.
- **R13 — sweep axis catalog + onboarding battery**: extend
  `src/mastra/agents/sweep-designer.agent.ts` (and researcher-capabilities)
  with a deterministically-checkable axis catalog (hold time, entry
  thresholds, stops/takes, cooldown, sizing, regime-as-axis), explicit
  "wide plateau, not peak" and "include the expected degradation point"
  prompt rules, a denylist for the leverage axis until a liquidation model
  exists (engine-side), and an onboarding grid battery at `strategy.onboard`
  before the first full WFO (all points recorded in the trial ledger).
