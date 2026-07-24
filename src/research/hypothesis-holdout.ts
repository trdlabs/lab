/**
 * R12a (research-validation-hardening, item 5a): fail-closed rollout resolver for
 * `LAB_HYPOTHESIS_HOLDOUT` — the E4b-pattern flag gating a lightweight, log-only holdout
 * confirmation of the proxy `PAPER_CANDIDATE` decision (`backtest-completed.handler.ts`).
 *
 * LOG-MODE ONLY (this slice): `off` (default) never enqueues the `hypothesis.holdout` task;
 * `log` enqueues it, runs one cheap single-fold holdout backtest, feeds `runBreakBattery`
 * (R11, `./break-battery.ts`), persists the report and emits events — but NEVER changes the
 * hypothesis status/verdict, exactly like `LAB_BREAK_BATTERY_MODE=log`. `enforce` is
 * deliberately NOT implemented: thresholds are an owner decision, pinned as
 * `battery-policy@1` (control-center `docs/architecture/battery-policy.md`) but not yet
 * calibrated against a real log-run distribution for the hypothesis-level holdout.
 *
 * The run logic (holdout submission + `runBreakBattery` wiring + persistence + events) is a
 * later slice (R12a Task 3, `hypothesis-holdout.handler.ts`) — this module only resolves the
 * mode and is the boot-time contract both `env.ts` and `composition.ts` depend on.
 */

/** Rollout mode. `enforce` intentionally absent — see module doc. */
export type HypothesisHoldoutMode = 'off' | 'log';

/**
 * Fail-closed parser for LAB_HYPOTHESIS_HOLDOUT (repo convention: a present-but-unrecognized
 * value is a deploy typo, not a request for the default). Mirrors `resolveBreakBatteryMode`
 * (R11, `./break-battery.ts`) exactly. `enforce` is rejected EXPLICITLY until the owner pins
 * calibrated thresholds — silently mapping it to `log` (or `off`) would misstate what
 * protection is active.
 */
export function resolveHypothesisHoldoutMode(raw: string | undefined): HypothesisHoldoutMode {
  if (raw === undefined || raw === '' || raw === 'off') return 'off';
  if (raw === 'log') return 'log';
  if (raw === 'enforce') {
    throw new Error(
      'LAB_HYPOTHESIS_HOLDOUT=enforce is not available until battery calibration closes — see '
      + 'control-center docs/architecture/battery-policy.md. Use off|log.',
    );
  }
  throw new Error(`LAB_HYPOTHESIS_HOLDOUT must be one of off|log, got '${raw}'`);
}
