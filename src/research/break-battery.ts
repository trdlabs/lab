/**
 * R11 (research-validation-hardening, report-13 gap G11): `break_battery@1` — the versioned,
 * deterministic "try to break the result" stage between the WFO verdict and the `paper.start`
 * enqueue (`strategy-wfo.handler`). It AGGREGATES the already-persisted R1–R3 signals over the
 * champion candidate into one structured report:
 *
 *   (a) `dsr_floor`       — DSR floor from the advisory E2 `trialContext` (R1);
 *   (b) `oos_degradation` — IS→OOS degradation ratio, same inputs as the R2 metric;
 *   (c) `plateau`         — lone-peak / plateau evidence of the selected grid point (R3).
 *
 * LOG-MODE ONLY (this slice): `LAB_BREAK_BATTERY_MODE=off` (default) never even invokes the
 * battery; `log` runs it, persists the report and emits an event — but NEVER changes the
 * experiment verdict / status / timings / retries. `enforce` is deliberately NOT implemented:
 * thresholds are an owner decision (initiative item 7); until then the floors below are
 * PRELIMINARY logging thresholds only (E4b-style rollout: advisory → log → staging → enforce).
 *
 * Determinism: every check is a pure function of persisted run data — no Date.now, no RNG,
 * no I/O. Feedback of a battery failure into the retry cycle MUST pass through the
 * Outcome-Embargo sanitizer (`sanitizeRetryFeedback`) — see buildBreakBatteryRetryFeedback.
 */
import type { TrialContext } from '../ports/research-platform.port.ts';
import type { OosDegradation } from '../validation/strategy-baseline-evaluator.ts';
import { sanitizeRetryFeedback, type SanitizedRetryFeedback } from './outcome-embargo.ts';

export const BREAK_BATTERY_VERSION = 'break_battery@1';

/** Rollout mode. `enforce` intentionally absent — see module doc. */
export type BreakBatteryMode = 'off' | 'log';

/**
 * Floors pinned by owner decision 2026-07-24 as `battery-policy@1` (research-validation
 * item 7; SSOT: control-center `docs/architecture/battery-policy.md`). Literature-anchored
 * starting values: Bailey & López de Prado's canonical DSR confidence 0.95 (deflatedSharpe
 * here IS the DSR probability — backtester `engine/deflated-sharpe.ts` returns normalCdf(z))
 * and Pardo's walk-forward-efficiency floor 0.5. Log-mode only: these constants never change
 * any verdict; calibration over real log-run distributions precedes enforce. Kept in ONE
 * place with an explicit policy version so a repin is a single, versioned change.
 */
export const BREAK_BATTERY_POLICY = {
  version: 'break-battery-policy@1',
  /** Check (a): fail when trialContext.deflatedSharpe < this floor (strict <). DSR is the
   *  probability that the true SR > 0 after multiple-testing deflation; 0.95 = the canonical
   *  95%-confidence threshold (Bailey & López de Prado 2014). */
  dsrFloor: 0.95,
  /** Check (b): fail when oosIsSharpeRatio < this floor (strict <) — mirrors the R2
   *  OOS_DEGRADATION_FRAGILITY_RATIO in strategy-baseline-evaluator.ts; matches Pardo's
   *  walk-forward-efficiency rule (OOS retains ≥ 50% of IS performance). */
  oosIsSharpeRatioFloor: 0.5,
} as const;

/** Canonical failure reason codes — fixed categorical tokens, never free text. Each MUST be
 *  present on outcome-embargo's SAFE_RETRY_REASONS allowlist (pinned by test). */
export const BREAK_BATTERY_REASON_CODES = {
  dsrBelowFloor: 'break_battery.dsr_below_floor',
  oosDegradation: 'break_battery.oos_degradation',
  lonePeak: 'break_battery.lone_peak',
} as const;

export type BreakCheckName = 'dsr_floor' | 'oos_degradation' | 'plateau';
export type BreakCheckStatus = 'passed' | 'failed' | 'skipped';
/** PRELIMINARY severity mapping (item 7 pins the real one alongside the floors). */
export type BreakCheckSeverity = 'critical' | 'warning' | 'info';

export interface BreakCheckResult {
  check: BreakCheckName;
  status: BreakCheckStatus;
  /** `break_battery.*` — canonical failure code, or a structural pass/skip code. */
  reasonCode: string;
  severity: BreakCheckSeverity;
  /** Deterministic inputs the check judged on (persistence lane only — never event payloads). */
  observed: Record<string, number | string | boolean | null>;
}

/** R3 plateau evidence of the SELECTED (champion) grid point, captured at ranking time. */
export interface PlateauSignal {
  lonePeak: boolean;
  neighborSharpeMedian?: number;
  neighborCount?: number;
  plateauEvidence?: 'insufficient_neighbors';
}

export interface BreakBatteryInput {
  /** R1: advisory E2 DSR/trial-ledger context from the OOS holdout run; absent when the
   *  backtester's trial ledger is disabled. */
  trialContext?: TrialContext;
  /** R2: IS→OOS degradation over the SAME inputs the holdout evaluation used. */
  oosDegradation: OosDegradation;
  /** R3: plateau evidence of the champion point; absent when no ranking context exists. */
  plateau?: PlateauSignal;
}

export interface BreakBatteryReport {
  batteryVersion: typeof BREAK_BATTERY_VERSION;
  policyVersion: string;
  /** 'break' when ANY check failed. A skipped check NEVER breaks (missing data ≠ failure). */
  outcome: 'pass' | 'break';
  checks: BreakCheckResult[];
  failedReasonCodes: string[];
}

function dsrFloorCheck(trialContext: TrialContext | undefined): BreakCheckResult {
  if (trialContext === undefined) {
    return {
      check: 'dsr_floor', status: 'skipped', reasonCode: 'break_battery.dsr_context_absent',
      severity: 'info', observed: {},
    };
  }
  const observed = {
    deflatedSharpe: trialContext.deflatedSharpe, trialCount: trialContext.trialCount,
    dsrFloor: BREAK_BATTERY_POLICY.dsrFloor,
  };
  if (trialContext.deflatedSharpe < BREAK_BATTERY_POLICY.dsrFloor) {
    return {
      check: 'dsr_floor', status: 'failed', reasonCode: BREAK_BATTERY_REASON_CODES.dsrBelowFloor,
      severity: 'critical', observed,
    };
  }
  return { check: 'dsr_floor', status: 'passed', reasonCode: 'break_battery.dsr_floor_ok', severity: 'info', observed };
}

function oosDegradationCheck(deg: OosDegradation): BreakCheckResult {
  if (deg.oosIsSharpeRatio === null) {
    return {
      check: 'oos_degradation', status: 'skipped', reasonCode: 'break_battery.oos_ratio_unavailable',
      severity: 'info', observed: { reason: deg.reason ?? null },
    };
  }
  const observed = {
    oosIsSharpeRatio: deg.oosIsSharpeRatio, oosIsPfRatio: deg.oosIsPfRatio,
    ratioFloor: BREAK_BATTERY_POLICY.oosIsSharpeRatioFloor, thresholdVersion: deg.thresholdVersion,
  };
  if (deg.oosIsSharpeRatio < BREAK_BATTERY_POLICY.oosIsSharpeRatioFloor) {
    return {
      check: 'oos_degradation', status: 'failed', reasonCode: BREAK_BATTERY_REASON_CODES.oosDegradation,
      severity: 'critical', observed,
    };
  }
  return { check: 'oos_degradation', status: 'passed', reasonCode: 'break_battery.oos_degradation_ok', severity: 'info', observed };
}

function plateauCheck(plateau: PlateauSignal | undefined): BreakCheckResult {
  if (plateau === undefined) {
    return {
      check: 'plateau', status: 'skipped', reasonCode: 'break_battery.plateau_context_absent',
      severity: 'info', observed: {},
    };
  }
  if (plateau.plateauEvidence === 'insufficient_neighbors') {
    // Mirrors rankTopN: never penalize a point for missing neighbors (grid edge / tiny grid).
    return {
      check: 'plateau', status: 'skipped', reasonCode: 'break_battery.plateau_insufficient_neighbors',
      severity: 'info', observed: { neighborCount: plateau.neighborCount ?? null },
    };
  }
  const observed = {
    lonePeak: plateau.lonePeak,
    neighborSharpeMedian: plateau.neighborSharpeMedian ?? null,
    neighborCount: plateau.neighborCount ?? null,
  };
  if (plateau.lonePeak) {
    return {
      check: 'plateau', status: 'failed', reasonCode: BREAK_BATTERY_REASON_CODES.lonePeak,
      severity: 'warning', observed,
    };
  }
  return { check: 'plateau', status: 'passed', reasonCode: 'break_battery.plateau_ok', severity: 'info', observed };
}

/** Pure + deterministic: same input → deep-equal report. Check order is part of the version. */
export function runBreakBattery(input: BreakBatteryInput): BreakBatteryReport {
  const checks: BreakCheckResult[] = [
    dsrFloorCheck(input.trialContext),
    oosDegradationCheck(input.oosDegradation),
    plateauCheck(input.plateau),
  ];
  const failedReasonCodes = checks.filter((c) => c.status === 'failed').map((c) => c.reasonCode);
  return {
    batteryVersion: BREAK_BATTERY_VERSION,
    policyVersion: BREAK_BATTERY_POLICY.version,
    outcome: failedReasonCodes.length > 0 ? 'break' : 'pass',
    checks,
    failedReasonCodes,
  };
}

/**
 * Fail-closed parser for LAB_BREAK_BATTERY_MODE (repo convention: a present-but-unrecognized
 * value is a deploy typo, not a request for the default). `enforce` is rejected EXPLICITLY
 * until item 7 pins the thresholds — silently mapping it to `log` (or `off`) would misstate
 * what protection is active.
 */
export function resolveBreakBatteryMode(raw: string | undefined): BreakBatteryMode {
  if (raw === undefined || raw === '' || raw === 'off') return 'off';
  if (raw === 'log') return 'log';
  if (raw === 'enforce') {
    throw new Error(
      'LAB_BREAK_BATTERY_MODE=enforce is not implemented yet — enforcement thresholds are an owner '
      + 'decision (research-validation-hardening item 7). Use off|log.',
    );
  }
  throw new Error(`LAB_BREAK_BATTERY_MODE must be one of off|log, got '${raw}'`);
}

/**
 * The ONLY sanctioned shape of battery feedback toward the generative retry cycle: canonical
 * failure codes routed through the Outcome-Embargo sanitizer (I-E5 fail-closed allowlist).
 * Raw reports (with observed magnitudes) belong to the persistence lane exclusively.
 * `subjectId` fills RetryFeedback.hypothesisId (WFO champion level: the experiment id).
 */
export function buildBreakBatteryRetryFeedback(report: BreakBatteryReport, subjectId: string): SanitizedRetryFeedback {
  return sanitizeRetryFeedback({
    hypothesisId: subjectId,
    decision: 'MODIFY',
    reasons: report.failedReasonCodes,
  });
}
