/** Provider outputs express "absent" as null; prod ChatIntentSchema uses `.optional()` (undefined). */
export function withoutNullProps(raw: unknown): unknown {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v !== null) out[k] = v;
  }
  return out;
}
