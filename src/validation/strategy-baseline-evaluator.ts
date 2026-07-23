import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';
import type { HoldoutBoundary, ExperimentFlags, ExperimentVerdict } from '../domain/research-experiment.ts';

// v2 (R2, research-validation-hardening item 2): rawScores now additionally carries
// `oosDegradation` on every evaluation row — a contract change to the persisted rawScores shape,
// even though the verdict ladder itself (thresholds, decision tree) is byte-for-byte unchanged.
// Most-conservative reading per repo convention: bump the evaluator version on ANY rawScores
// shape change, not only on verdict-ladder changes.
export const STRATEGY_BASELINE_EVALUATOR_VERSION = 'strategy-baseline-v2';
export const STRATEGY_BASELINE_THRESHOLDS = { minSharpe: 0, minProfitFactor: 1, minTrades: 1 } as const;

/** Threshold-ladder tag for the OOS-degradation metric itself — versioned independently of
 *  STRATEGY_BASELINE_EVALUATOR_VERSION so a future SSOT threshold repin (item 7) doesn't force
 *  an unrelated bump of the baseline ladder's own version. */
export const OOS_DEGRADATION_THRESHOLD_VERSION = 'oos-degradation-v1';

/** PRELIMINARY — pending SSOT threshold pinning (research-validation-hardening item 7). A
 *  ratio below this fraction of the IS baseline marks `oos_degradation` in `flags.fragility`.
 *  Log-mode only (R2): this constant never changes the verdict, only an informational flag. */
const OOS_DEGRADATION_FRAGILITY_RATIO = 0.5;

export interface OosDegradation {
  oosIsSharpeRatio: number | null;
  oosIsPfRatio: number | null;
  isSharpe?: number;
  oosSharpe: number;
  isPF?: number;
  oosPF: number;
  thresholdVersion: string;
  /** Present only when a ratio could not be computed (IS block absent, or its own baseline is
   *  non-positive/unusable — sharpe<=0 or PF<=1). Deterministic; never a division artifact. */
  reason?: 'is_baseline_nonpositive';
}

/** oosSharpe/isSharpe and oosPF/isPF — deterministic, division-by-invalid-baseline excluded.
 *  `train` (IS/train-window block) is optional: absent, or with a non-positive baseline
 *  (isSharpe<=0 or isPF<=1) the ratio is meaningless, so both ratios come back `null` with a
 *  fixed `reason` rather than a NaN/Infinity. */
export function computeOosDegradation(train: BacktestMetricBlock | undefined, holdout: BacktestMetricBlock): OosDegradation {
  const base = {
    oosSharpe: holdout.sharpe, oosPF: holdout.profitFactor, thresholdVersion: OOS_DEGRADATION_THRESHOLD_VERSION,
  };

  if (!train || train.sharpe <= 0 || train.profitFactor <= 1) {
    return {
      ...base,
      oosIsSharpeRatio: null,
      oosIsPfRatio: null,
      ...(train ? { isSharpe: train.sharpe, isPF: train.profitFactor } : {}),
      reason: 'is_baseline_nonpositive',
    };
  }

  return {
    ...base,
    oosIsSharpeRatio: holdout.sharpe / train.sharpe,
    oosIsPfRatio: holdout.profitFactor / train.profitFactor,
    isSharpe: train.sharpe,
    isPF: train.profitFactor,
  };
}

export interface StrategyBaselineEvaluation {
  verdict: ExperimentVerdict;
  verdictReason?: string;
  rawScores: Record<string, unknown>;
  flags: ExperimentFlags;
}

export function evaluateStrategyBaseline(
  input: { holdout: BacktestMetricBlock; boundary: HoldoutBoundary; train?: BacktestMetricBlock },
): StrategyBaselineEvaluation {
  const t = STRATEGY_BASELINE_THRESHOLDS;
  const flags: ExperimentFlags = { lowConfidenceHoldout: input.boundary.lowConfidence, overfit: false, fragility: [], coverageWarnings: [] };

  // R2 (log-mode): computed + recorded unconditionally — never gates the verdict below.
  const oosDegradation = computeOosDegradation(input.train, input.holdout);
  if (oosDegradation.oosIsSharpeRatio !== null && oosDegradation.oosIsSharpeRatio < OOS_DEGRADATION_FRAGILITY_RATIO) {
    flags.fragility.push('oos_degradation');
  }

  const rawScores = { thresholds: t, holdout: input.holdout, holdoutTrades: input.boundary.holdoutTrades, oosDegradation };

  if (input.boundary.lowConfidence) {
    return { verdict: 'INCONCLUSIVE', verdictReason: 'low_confidence', rawScores, flags };
  }

  const viable = input.holdout.totalTrades >= t.minTrades && input.holdout.profitFactor >= t.minProfitFactor && input.holdout.sharpe > t.minSharpe;
  if (viable) {
    return { verdict: 'PAPER_CANDIDATE', rawScores, flags };
  }

  return { verdict: 'FAIL', verdictReason: 'baseline_below_floor', rawScores, flags };
}
