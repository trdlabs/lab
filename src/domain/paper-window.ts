// src/domain/paper-window.ts
//
// Pure decision core for "is the paper observation window complete" (§2.5, trade-count
// adaptive paper window). No I/O — env loading + composition-time validation live in
// src/config/env.ts and the composition root respectively.

const MS_PER_DAY = 24 * 3600 * 1000;

export interface PaperWindowPolicy {
  /** Trade count that closes the window with full confidence. */
  minTrades: number;
  /** At maxDays, closedTrades >= this (but < minTrades) still closes the window, flagged low-confidence. */
  lowConfidenceThreshold: number;
  /** Minimum elapsed days before the window can ever complete, regardless of trade count. */
  minDays: number;
  /** Elapsed days at which the window forces a verdict (complete/low-confidence or stalled). */
  maxDays: number;
  /** Max days the monitor should keep waiting before treating the run as unresponsive (consumer-owned). */
  maxWaitDays: number;
}

export type PaperWindowVerdict =
  | { state: 'watching' }
  | { state: 'window_complete'; lowConfidence: boolean }
  | { state: 'stalled' };

/** Throws with the violated invariant named. */
export function validatePaperWindowPolicy(p: PaperWindowPolicy): void {
  for (const [key, value] of Object.entries(p) as [keyof PaperWindowPolicy, number][]) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`PaperWindowPolicy.${key} must be a positive integer (got ${value}).`);
    }
  }
  if (p.lowConfidenceThreshold > p.minTrades) {
    throw new Error(
      `PaperWindowPolicy.lowConfidenceThreshold (${p.lowConfidenceThreshold}) must be <= minTrades (${p.minTrades}).`,
    );
  }
  if (p.minDays > p.maxDays) {
    throw new Error(`PaperWindowPolicy.minDays (${p.minDays}) must be <= maxDays (${p.maxDays}).`);
  }
  // maxWaitDays >= 1 is already guaranteed by the positive-integer check above (integer > 0 => >= 1);
  // named here for documentation parity with the invariant list.
}

const POLICY_KEYS: readonly (keyof PaperWindowPolicy)[] = [
  'minTrades',
  'lowConfidenceThreshold',
  'minDays',
  'maxDays',
  'maxWaitDays',
];

/**
 * Resolves the effective window policy from a persisted (jsonb) snapshot, falling back to the
 * live env-validated policy when the snapshot is missing, partial, or otherwise invalid — e.g. a
 * future field rename or a manual edit. Without this guard, a corrupted snapshot makes every
 * comparison in evaluatePaperWindow compare against `undefined` (always false), which pins the
 * verdict at 'watching' forever (unbounded self-reschedule) instead of surfacing loudly.
 */
export function resolveWindowPolicy(
  snapshot: Record<string, unknown> | undefined,
  fallback: PaperWindowPolicy,
): PaperWindowPolicy {
  if (!snapshot) return fallback;
  if (!POLICY_KEYS.every((key) => typeof snapshot[key] === 'number')) return fallback;
  const candidate = snapshot as unknown as PaperWindowPolicy;
  try {
    validatePaperWindowPolicy(candidate);
    return candidate;
  } catch {
    return fallback;
  }
}

export function evaluatePaperWindow(
  policy: PaperWindowPolicy,
  input: { runStartedAtMs: number; nowMs: number; closedTrades: number },
): PaperWindowVerdict {
  const elapsedDays = (input.nowMs - input.runStartedAtMs) / MS_PER_DAY;
  if (elapsedDays < policy.minDays) return { state: 'watching' };
  if (input.closedTrades >= policy.minTrades) return { state: 'window_complete', lowConfidence: false };
  if (elapsedDays >= policy.maxDays) {
    return input.closedTrades >= policy.lowConfidenceThreshold
      ? { state: 'window_complete', lowConfidence: true }
      : { state: 'stalled' };
  }
  return { state: 'watching' };
}
