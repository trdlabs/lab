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

- **R1 (consumer side)**: persist `RunResultSummary.trialContext`
  (trialCount, deflatedSharpe — already in the backtester SDK contract,
  advisory) into `experiment_evaluation`, so DSR becomes available to the
  ladders.
- **R2 — IS→OOS degradation**: compute `oosSharpe/isSharpe`, `oosPF/isPF` in
  the holdout evaluation and add an `oos_degradation` rung to the ladder in
  `src/validation/strategy-baseline-evaluator.ts` (today's floors —
  `sharpe > 0 ∧ PF ≥ 1` — pass a strategy whose OOS collapsed vs IS).
  Log-mode first, enforce after calibration.
- **R3 — plateau analysis**: in `src/research/top-n-prefilter.ts::rankTopN`,
  a deterministic neighbour-cell stability metric per grid point; lone peak →
  `lone_peak` flag, rank lowered; flag surfaced to the result-interpreter as
  a fact.
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
