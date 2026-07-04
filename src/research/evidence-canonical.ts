// Vendored canonicalizer — byte-identical to backtester apps/backtester/src/evidence/canonical.ts
// SOURCE: trading-backtester/apps/backtester/src/evidence/canonical.ts (itself a mirror of
// trading-platform evidence-verifier.ts::canonicalizeEvidenceBody). VERSION: v1 (2026-07-04).
//
// Recursive sorted-key JSON stringify: object keys sorted, array order PRESERVED (not sorted),
// primitives via JSON.stringify, no trailing newline, no number quantization.
export function canonicalizeEvidenceBody(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeEvidenceBody).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeEvidenceBody(obj[k])}`).join(',')}}`;
}
