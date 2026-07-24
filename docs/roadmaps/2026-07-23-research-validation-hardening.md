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
- **R12 (2026-07-24) — done.** Ships in two parts. R12b:
  `hypothesisFamilyHint` (`src/research/hypothesis-family.ts`) derives a
  stable `hypothesis:<rootId>` family key (self id, or the domain's
  `derivedFrom` when present) and is threaded as the SDK's existing advisory
  `trialFamilyHint` field through both hypothesis submit paths —
  `HttpBacktesterAdapter.submitOverlayRun` / `submitStrategyResearchRun` — so
  every hypothesis run, both the cycleDepth-0 `runNewStrategyValidation` lane
  and every FAIL/MODIFY retry's overlay lane, registers into the backtester
  trial ledger under its own family instead of collapsing into the preset's
  `moduleRef` family. R12a: flag `LAB_HYPOTHESIS_HOLDOUT` (`off` default →
  `log`; `enforce` rejected at boot until battery calibration closes — same
  fail-closed shape as `LAB_BREAK_BATTERY_MODE`) gates a new orchestrator
  task `hypothesis.holdout`, enqueued from the `PAPER_CANDIDATE` branch of
  `backtest-completed.handler.ts`. The task runs exactly one single-fold
  holdout backtest of the same bundle — window resolved via the same
  `resolveHoldoutBoundary` / `encodeHoldoutPeriod` path
  `runNewStrategyValidation` uses, no WFO ladder, no grid — and feeds it into
  `runBreakBattery` (R11) with `plateau` omitted (no grid at the hypothesis
  level → the plateau check reports `skipped`, non-breaking). The full
  report persists to a new nullable `hypothesis_proposal.holdout_battery`
  jsonb column (migration 0028, no backfill, mirrors
  `trial_context`/migration 0027); events
  `hypothesis.holdout.started/completed/skipped/failed` are structural only
  (outcome + `break_battery.*` codes, never observed magnitudes). Neither
  part ever touches `HypothesisStatus` or the `PAPER_CANDIDATE` decision —
  log-only, exactly like R11.

  Decisions: **L1-only family identity** — `HypothesisProposal` has no
  `derivedFrom`/lineage field today, so a FAIL/MODIFY retry's rebuilt
  hypothesis gets its OWN family key; retries of the same underlying idea do
  NOT yet discount each other in the trial ledger. This is a deliberate scope
  cut, not an oversight — closing it needs a `derivedFrom` contract on the
  bundle manifest (L2, out of scope here; see the tail below). Plateau
  analysis at the hypothesis level is intentionally absent — there is no
  grid to compute neighbor-stability over. The IS baseline fed into
  `computeOosDegradation` is the PAPER_CANDIDATE run's stored full-period
  metric block — a proxy-run baseline, slightly optimistic versus a true
  IS/OOS split; the DSR floor (via the run's `trialContext`, now discoverable
  through the `trialFamilyHint` ledger membership) is the sharper signal,
  not this ratio. Skip ≠ fail: four reason codes
  (`is_baseline_unavailable`, `holdout_window_unavailable`,
  `bundle_unavailable`, `backtest_run_unavailable`) resolve successfully as
  `skipped`; only unexpected throws or a non-completed holdout run are
  `failed`.

  Tail: `enforce` awaits `battery-policy@1` calibration, same gate as R11
  (item 7). Family-merge of FAIL/MODIFY retries needs a `derivedFrom`
  contract wired through the bundle manifest — deferred to a follow-up R12
  slice.
- **R12 — hypothesis-cycle hardening**: today a hypothesis verdict is one
  in-sample overlay run with delta thresholds and `PAPER_CANDIDATE` at the
  hypothesis level is explicitly a proxy
  (`backtest-completed.handler.ts`). Add (a) a lightweight holdout
  confirmation of the proxy status (flag `LAB_HYPOTHESIS_HOLDOUT`), and
  (b) register every hypothesis as a family trial in the backtester trial
  ledger so FAIL/MODIFY retries and many-hypotheses selection get discounted
  via DSR automatically.
- **R13 (2026-07-24) — done.** Typed axis catalog `SWEEP_AXIS_CATALOG`
  (`hold_time`, `entry_thresholds`, `stops_takes`, `cooldown`, `sizing`,
  `regime_as_axis`, plus `leverage` denylisted) with a prompt export; the "wide
  plateau, not peak" and "include the expected degradation point" rules plus
  the leverage denylist are wired into the sweep-designer prompts
  (`SWEEP_DESIGNER_INSTRUCTIONS`) and researcher-capabilities. A deterministic
  `denylisted_axis:*` gate lands in `validateSweepGrid` (the denylist check
  runs first, the four pre-existing reason codes are untouched). Onboarding
  battery: flag `LAB_ONBOARD_BATTERY_MODE` (`off` default → `log`, fail-closed)
  hooks into `strategy-baseline.handler` right before `strategy.wfo` is
  enqueued — a deterministic ±50% grid around the baseline values, built from
  the axis catalog (no LLM, capped at 12 points, axes picked greedily by name),
  runs through `ParamGridRunner`; every point lands server-side in the trial
  ledger, and a `strategy.onboard_battery.completed` event (counts +
  `lonePeak`, no magnitudes) plus an artifact summary close the run. Fail-soft:
  the baseline→wfo chain never breaks on battery failure. The
  `hold_time`/`sizing` matchers were narrowed to remove threshold/resize
  collisions.

  Decisions: the grid is built without an LLM (determinism over creativity at
  this stage); at most 2 axes combine (3×3 ≤ 12 cap); the result surfaces via
  event + artifact rather than a new migration; `enforce` is not implemented —
  this is a log-only stage.

  Tail: `trialFamilyHint` is absent from the strategy lane —
  `StrategyExperimentRunRequest` carries no such field (the wire contract was
  left untouched), so onboarding-battery points land in the trial ledger
  without a profile hint and are grouped by `moduleRef.id` + window instead — a
  separate task if that grouping turns out to matter. Merging the battery's
  plateau points into the first WFO round is deferred as YAGNI.
- **R13 — sweep axis catalog + onboarding battery**: extend
  `src/mastra/agents/sweep-designer.agent.ts` (and researcher-capabilities)
  with a deterministically-checkable axis catalog (hold time, entry
  thresholds, stops/takes, cooldown, sizing, regime-as-axis), explicit
  "wide plateau, not peak" and "include the expected degradation point"
  prompt rules, a denylist for the leverage axis until a liquidation model
  exists (engine-side), and an onboarding grid battery at `strategy.onboard`
  before the first full WFO (all points recorded in the trial ledger).
