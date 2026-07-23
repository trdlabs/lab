// src/research/break-battery.test.ts
import { describe, it, expect } from 'vitest';
import {
  BREAK_BATTERY_VERSION, BREAK_BATTERY_POLICY, BREAK_BATTERY_REASON_CODES,
  runBreakBattery, resolveBreakBatteryMode, buildBreakBatteryRetryFeedback,
} from './break-battery.ts';
import type { BreakBatteryInput, BreakBatteryReport } from './break-battery.ts';
import { SAFE_RETRY_REASONS, sanitizeRetryFeedback } from './outcome-embargo.ts';
import { computeOosDegradation } from '../validation/strategy-baseline-evaluator.ts';
import type { TrialContext } from '../ports/research-platform.port.ts';
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function trialContext(over: Partial<TrialContext> = {}): TrialContext {
  return {
    familyKey: 'fam-1', trialCount: 12, deflatedSharpe: 0.9,
    sr0: 0.4, vSR: 0.01, vSRBasis: 'asymptotic', tCount: 42,
    ...over,
  };
}

function metrics(over: Partial<BacktestMetricBlock>): BacktestMetricBlock {
  return {
    netPnlUsd: 0, netPnlPct: 0, totalTrades: 10, winRate: 0.5, profitFactor: 1.5,
    maxDrawdownPct: 5, expectancyUsd: 1, sharpe: 1, topTradeContributionPct: 10,
    ...over,
  };
}

/** Input where every check passes: healthy DSR, OOS ≈ IS, wide plateau. */
function passingInput(over: Partial<BreakBatteryInput> = {}): BreakBatteryInput {
  return {
    trialContext: trialContext(),
    oosDegradation: computeOosDegradation(
      metrics({ sharpe: 1, profitFactor: 1.5 }),
      metrics({ sharpe: 0.9, profitFactor: 1.4 }),
    ),
    plateau: { lonePeak: false, neighborSharpeMedian: 0.9, neighborCount: 3 },
    ...over,
  };
}

function checkByName(report: BreakBatteryReport, name: string) {
  const found = report.checks.find((c) => c.check === name);
  expect(found, `check '${name}' must be present`).toBeDefined();
  return found!;
}

// ---------------------------------------------------------------------------
// Battery versioning + shape
// ---------------------------------------------------------------------------

describe('runBreakBattery — versioning and shape', () => {
  it('reports the battery version and the preliminary policy version on every run', () => {
    const report = runBreakBattery(passingInput());
    expect(report.batteryVersion).toBe(BREAK_BATTERY_VERSION);
    expect(BREAK_BATTERY_VERSION).toBe('break_battery@1');
    expect(report.policyVersion).toBe(BREAK_BATTERY_POLICY.version);
    expect(report.checks.map((c) => c.check)).toEqual(['dsr_floor', 'oos_degradation', 'plateau']);
  });

  it('is deterministic: identical input → deep-equal report', () => {
    const input = passingInput({ trialContext: trialContext({ deflatedSharpe: 0.2 }) });
    expect(runBreakBattery(input)).toEqual(runBreakBattery(input));
  });

  it('all-pass input → outcome pass with no failed reason codes', () => {
    const report = runBreakBattery(passingInput());
    expect(report.outcome).toBe('pass');
    expect(report.failedReasonCodes).toEqual([]);
    expect(report.checks.every((c) => c.status !== 'failed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Check (a): DSR floor from trialContext
// ---------------------------------------------------------------------------

describe('runBreakBattery — dsr_floor check', () => {
  it('skips (never fails) when trialContext is absent', () => {
    const report = runBreakBattery(passingInput({ trialContext: undefined }));
    const check = checkByName(report, 'dsr_floor');
    expect(check.status).toBe('skipped');
    expect(report.outcome).toBe('pass');
  });

  it('fails below the floor with reason code break_battery.dsr_below_floor', () => {
    const report = runBreakBattery(passingInput({
      trialContext: trialContext({ deflatedSharpe: BREAK_BATTERY_POLICY.dsrFloor - 0.01 }),
    }));
    const check = checkByName(report, 'dsr_floor');
    expect(check.status).toBe('failed');
    expect(check.reasonCode).toBe(BREAK_BATTERY_REASON_CODES.dsrBelowFloor);
    expect(report.outcome).toBe('break');
    expect(report.failedReasonCodes).toContain('break_battery.dsr_below_floor');
  });

  it('passes exactly AT the floor (fail is strict <)', () => {
    const report = runBreakBattery(passingInput({
      trialContext: trialContext({ deflatedSharpe: BREAK_BATTERY_POLICY.dsrFloor }),
    }));
    expect(checkByName(report, 'dsr_floor').status).toBe('passed');
  });
});

// ---------------------------------------------------------------------------
// Check (b): IS→OOS degradation (same inputs as the R2 oos_degradation metric)
// ---------------------------------------------------------------------------

describe('runBreakBattery — oos_degradation check', () => {
  it('skips when the ratio is unavailable (IS baseline non-positive)', () => {
    const report = runBreakBattery(passingInput({
      oosDegradation: computeOosDegradation(
        metrics({ sharpe: -1, profitFactor: 0.5 }), // unusable IS baseline → null ratios
        metrics({ sharpe: 0.9 }),
      ),
    }));
    const check = checkByName(report, 'oos_degradation');
    expect(check.status).toBe('skipped');
    expect(report.outcome).toBe('pass');
  });

  it('fails below the ratio floor with reason code break_battery.oos_degradation', () => {
    const report = runBreakBattery(passingInput({
      oosDegradation: computeOosDegradation(
        metrics({ sharpe: 2, profitFactor: 2 }),
        metrics({ sharpe: 0.2, profitFactor: 1.1 }), // 0.2/2 = 0.1 < 0.5
      ),
    }));
    const check = checkByName(report, 'oos_degradation');
    expect(check.status).toBe('failed');
    expect(check.reasonCode).toBe(BREAK_BATTERY_REASON_CODES.oosDegradation);
    expect(report.outcome).toBe('break');
  });

  it('passes exactly AT the ratio floor (fail is strict <)', () => {
    const report = runBreakBattery(passingInput({
      oosDegradation: computeOosDegradation(
        metrics({ sharpe: 2, profitFactor: 2 }),
        metrics({ sharpe: 2 * BREAK_BATTERY_POLICY.oosIsSharpeRatioFloor, profitFactor: 2 }),
      ),
    }));
    expect(checkByName(report, 'oos_degradation').status).toBe('passed');
  });
});

// ---------------------------------------------------------------------------
// Check (c): plateau / lone peak
// ---------------------------------------------------------------------------

describe('runBreakBattery — plateau check', () => {
  it('skips when no plateau signal was captured for the champion point', () => {
    const report = runBreakBattery(passingInput({ plateau: undefined }));
    expect(checkByName(report, 'plateau').status).toBe('skipped');
    expect(report.outcome).toBe('pass');
  });

  it('skips (never fails) on insufficient neighbors', () => {
    const report = runBreakBattery(passingInput({
      plateau: { lonePeak: false, neighborCount: 1, plateauEvidence: 'insufficient_neighbors' },
    }));
    expect(checkByName(report, 'plateau').status).toBe('skipped');
    expect(report.outcome).toBe('pass');
  });

  it('fails on a lone peak with reason code break_battery.lone_peak', () => {
    const report = runBreakBattery(passingInput({
      plateau: { lonePeak: true, neighborSharpeMedian: 0.1, neighborCount: 3 },
    }));
    const check = checkByName(report, 'plateau');
    expect(check.status).toBe('failed');
    expect(check.reasonCode).toBe(BREAK_BATTERY_REASON_CODES.lonePeak);
    expect(report.outcome).toBe('break');
  });
});

// ---------------------------------------------------------------------------
// Mode flag
// ---------------------------------------------------------------------------

describe('resolveBreakBatteryMode', () => {
  it("defaults to 'off' on unset/empty", () => {
    expect(resolveBreakBatteryMode(undefined)).toBe('off');
    expect(resolveBreakBatteryMode('')).toBe('off');
  });

  it("accepts 'off' and 'log'", () => {
    expect(resolveBreakBatteryMode('off')).toBe('off');
    expect(resolveBreakBatteryMode('log')).toBe('log');
  });

  it("rejects 'enforce' (deferred to item 7 — thresholds are an owner decision)", () => {
    expect(() => resolveBreakBatteryMode('enforce')).toThrow(/enforce/);
  });

  it('rejects unknown values fail-closed (deploy typo, not a request for the default)', () => {
    expect(() => resolveBreakBatteryMode('LOG')).toThrow();
    expect(() => resolveBreakBatteryMode('on')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Retry feedback MUST pass through the Outcome-Embargo sanitizer
// ---------------------------------------------------------------------------

describe('buildBreakBatteryRetryFeedback — Outcome-Embargo sanitizer', () => {
  it('every canonical failure code is on the fail-closed retry allowlist', () => {
    for (const code of Object.values(BREAK_BATTERY_REASON_CODES)) {
      expect(SAFE_RETRY_REASONS.has(code), `${code} must be allowlisted`).toBe(true);
    }
  });

  it('failure codes survive sanitization intact (nothing dropped)', () => {
    const report = runBreakBattery(passingInput({
      trialContext: trialContext({ deflatedSharpe: 0.1 }),
      plateau: { lonePeak: true, neighborSharpeMedian: 0.1, neighborCount: 3 },
    }));
    expect(report.outcome).toBe('break');
    const sanitized = buildBreakBatteryRetryFeedback(report, 'exp-1');
    expect(sanitized.feedback.decision).toBe('MODIFY');
    expect(sanitized.feedback.reasons).toEqual(report.failedReasonCodes);
    expect(sanitized.removedKeys).toEqual([]);
  });

  it('a pass report yields empty reasons (nothing to feed back)', () => {
    const sanitized = buildBreakBatteryRetryFeedback(runBreakBattery(passingInput()), 'exp-1');
    expect(sanitized.feedback.reasons).toEqual([]);
  });

  it('free-text reasons are DROPPED by the sanitizer (fail-closed allowlist demo)', () => {
    const leaked = sanitizeRetryFeedback({
      hypothesisId: 'exp-1', decision: 'MODIFY',
      reasons: ['break_battery.dsr_below_floor', 'holdout sharpe was 0.2 on 2023-04-01'],
    });
    expect(leaked.feedback.reasons).toEqual(['break_battery.dsr_below_floor']);
    expect(leaked.removedKeys).toEqual(['reasons[1]']);
  });
});
