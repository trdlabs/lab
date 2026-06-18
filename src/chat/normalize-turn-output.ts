/**
 * Deep null-stripping normalizer for TurnInterpretation provider output.
 *
 * Provider models express "absent optional" as `null` (OpenAI strict schema requires every key
 * in `required`). TurnInterpretationSchema uses `.optional()` (undefined). A shallow strip like
 * `withoutNullProps` only removes top-level nulls — the nested `constraints` object can still
 * carry null values (e.g. `{ market: null, timeframe: '1m' }`) that would be REJECTED by the
 * strict schema after a shallow pass.
 *
 * This function strips nulls recursively: top-level AND one level into nested plain objects
 * (sufficient for the `constraints` nesting depth). Arrays are left as-is (the schema has
 * `references: z.array(...)` which contains non-nullable strings).
 *
 * DO NOT modify `withoutNullProps` — this is a separate function with different semantics.
 */
export function normalizeTurnOutput(raw: unknown): unknown {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return raw;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === null) continue; // strip top-level nulls

    if (v != null && typeof v === 'object' && !Array.isArray(v)) {
      // Recurse one level into nested plain objects (e.g. constraints).
      const nested: Record<string, unknown> = {};
      for (const [nk, nv] of Object.entries(v as Record<string, unknown>)) {
        if (nv !== null) nested[nk] = nv;
      }
      out[k] = nested;
    } else {
      out[k] = v;
    }
  }
  return out;
}
