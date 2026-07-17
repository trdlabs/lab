/**
 * Outcome Embargo (E4b lab obligation) — durable policy: held-out / qualification
 * outcome data must never enter LLM generation context.
 * Spec: docs/superpowers/specs/2026-07-17-outcome-embargo-design.md
 *
 * Always on — no config flag (I-E3). Applies to the GENERATION lane only:
 * deterministic evaluators, persistence, scorecards, and the read-API keep
 * full access to holdout data and are never scrubbed.
 */

const EMBARGOED_TOKENS = new Set(['holdout', 'heldout', 'oos', 'promotion', 'qualification']);
/** Multi-segment sequences embargoed even though their individual tokens are not. */
const EMBARGOED_SEQUENCES: readonly (readonly string[])[] = [
  ['out', 'of', 'sample'],
  ['evaluation', 'window'],
  ['held', 'out'],
  ['hold', 'out'],
];

/** Lowercase segments split on snake_case / kebab-case / dot / camelCase / letter-digit boundaries. */
function segmentsOf(key: string): string[] {
  return key
    .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([a-zA-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]/g, ' ')
    .toLowerCase()
    .split(' ')
    .filter((s) => s.length > 0);
}

/**
 * The embargo CATEGORY a key belongs to (`holdout`, `promotion`, `out_of_sample`, …)
 * or null if the key is not embargoed. The category is a fixed structural label
 * derived only from the matched token/sequence — it deliberately discards the rest
 * of the key so a categorical VALUE glued into the name (`promotion_REJECT`,
 * `qualification_failed`, `holdout_winner_degradation`) can never be reported.
 */
export function embargoCategory(key: string): string | null {
  const segs = segmentsOf(key);
  for (const s of segs) {
    if (EMBARGOED_TOKENS.has(s)) return s;
  }
  for (let i = 0; i < segs.length; i += 1) {
    for (const seq of EMBARGOED_SEQUENCES) {
      if (i + seq.length <= segs.length && seq.every((tok, j) => segs[i + j] === tok)) {
        return seq.join('_');
      }
    }
  }
  return null;
}

export function isEmbargoedMetricKey(key: string): boolean {
  return embargoCategory(key) !== null;
}

export interface ScrubResult<T> {
  scrubbed: T;
  /**
   * Structural-only paths of removed keys — NEVER values (spec §6.1). No raw
   * object-key name ever appears: an embargoed key is reported as its fixed
   * CATEGORY token (`<holdout>`, `<promotion>`, …), and every non-embargoed
   * parent object-key is replaced by `*`. Array indices (`[0]`) are positional
   * structure and are preserved. So a path is at most category + depth +
   * array position, e.g. `[1].*.<holdout>` — carrying no metric magnitude,
   * verdict, reason, window boundary, date, or id.
   */
  removedKeys: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function scrubValue(value: unknown, path: string, removed: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item, i) => scrubValue(item, `${path}[${i}]`, removed));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // out[] uses the RAW key (data integrity); the reported path never does.
      const category = embargoCategory(k);
      if (category !== null) {
        const label = `<${category}>`;
        removed.push(path ? `${path}.${label}` : label);
        continue;
      }
      // Non-embargoed object keys collapse to `*`: a categorical/value-bearing
      // parent name (verdict_REJECT, a date-keyed bucket) must never ride out.
      const p = path ? `${path}.*` : '*';
      out[k] = scrubValue(v, p, removed);
    }
    return out;
  }
  return value;
}

/**
 * Recursively remove embargoed keys from a metric bag / nested structure
 * (comparison blocks, ranked topN, future SDK fields). Returns a scrubbed
 * deep copy + removed key paths. Primitives pass through unchanged.
 */
export function scrubMetricsBag<T>(bag: T): ScrubResult<T> {
  const removedKeys: string[] = [];
  const scrubbed = scrubValue(bag, '', removedKeys) as T;
  return { scrubbed, removedKeys };
}

/** Proxy-lane evaluator codes — src/validation/evaluator.ts (deterministic ladder). */
const EVALUATOR_REASONS = [
  'insufficient_sample', 'no_improvement_over_baseline', 'drawdown_regression',
  'fragile_pnl', 'strong_robust_edge', 'positive_edge',
] as const;
/** Preservation-veto codes — src/validation/trade-preservation.ts (R2 gate). */
const PRESERVATION_REASONS = ['end_of_data_position', 'abstention_gaming', 'winner_degradation'] as const;

/** Fail-closed allowlist for retry-feedback reasons (I-E5). */
export const SAFE_RETRY_REASONS: ReadonlySet<string> = new Set([...EVALUATOR_REASONS, ...PRESERVATION_REASONS]);

/** Proxy-lane evaluation decisions (BacktestCompletedPayloadSchema enum). */
const SAFE_RETRY_DECISIONS = new Set(['PASS', 'FAIL', 'MODIFY', 'INCONCLUSIVE', 'PAPER_CANDIDATE']);

export interface RetryFeedback {
  readonly hypothesisId: string;
  readonly decision: string;
  readonly reasons: readonly string[];
}

export interface SanitizedRetryFeedback {
  feedback: { hypothesisId: string; decision: string; reasons: string[] };
  /** Index paths of dropped reasons (e.g. 'reasons[2]') — never the dropped text. */
  removedKeys: string[];
}

/**
 * Allowlist filter over retry-feedback reasons. Unknown values are DROPPED —
 * free-text reasons may embed embargoed metric/window text. Touches ONLY the
 * feedback object; control-plane payload fields (evalPlatformRun, …) are out
 * of scope by design (I-E2).
 */
export function sanitizeRetryFeedback(feedback: RetryFeedback): SanitizedRetryFeedback {
  const reasons: string[] = [];
  const removedKeys: string[] = [];
  feedback.reasons.forEach((r, i) => {
    if (SAFE_RETRY_REASONS.has(r)) reasons.push(r);
    else removedKeys.push(`reasons[${i}]`);
  });
  let decision = feedback.decision;
  if (!SAFE_RETRY_DECISIONS.has(decision)) {
    decision = '';
    removedKeys.push('decision');
  }
  return {
    feedback: { hypothesisId: feedback.hypothesisId, decision, reasons },
    removedKeys,
  };
}
