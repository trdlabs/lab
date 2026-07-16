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
];

/** Lowercase segments split on snake_case / kebab-case / dot / camelCase boundaries. */
function segmentsOf(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]/g, ' ')
    .toLowerCase()
    .split(' ')
    .filter((s) => s.length > 0);
}

export function isEmbargoedMetricKey(key: string): boolean {
  const segs = segmentsOf(key);
  if (segs.some((s) => EMBARGOED_TOKENS.has(s))) return true;
  for (const seq of EMBARGOED_SEQUENCES) {
    for (let i = 0; i + seq.length <= segs.length; i += 1) {
      if (seq.every((tok, j) => segs[i + j] === tok)) return true;
    }
  }
  return false;
}

export interface ScrubResult<T> {
  scrubbed: T;
  /** Dot/index-joined paths of removed keys — names only, NEVER values (spec §6.1). */
  removedKeys: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function scrubValue(value: unknown, path: string, removed: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item, i) => scrubValue(item, `${path}[${i}]`, removed));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const p = path ? `${path}.${k}` : k;
      if (isEmbargoedMetricKey(k)) {
        removed.push(p);
        continue;
      }
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
