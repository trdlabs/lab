import type { AssembledStrategyBundle } from '../domain/strategy-bundle.ts';

/**
 * Verdict of the lab-side pre-submit gate for a strategy bundle.
 * `rejected` is a normal outcome (fail-closed) — never thrown; `throw` is reserved for infra errors.
 */
export type ValidationVerdict =
  | { readonly status: 'valid' }
  | { readonly status: 'rejected'; readonly reason: string; readonly violations: string[] };

/**
 * Lexical ambient-authority signatures (CH-2), mirroring the platform's `scanAmbientAuthority`.
 * Any hit in untrusted module code → fail-closed. Built from fragments so this host file does not
 * itself look like a consumer of these capabilities.
 */
const Q = `['"]`;
const NODE = `(?:node:)?`;
const AMBIENT_PATTERNS: ReadonlyArray<{ readonly id: string; readonly re: RegExp }> = [
  { id: 'process_access', re: /\bprocess\s*\.\s*(?:env|binding|dlopen|exit|kill|mainModule)\b/ },
  { id: 'dynamic_import', re: /\bimport\s*\(/ },
  { id: 'code_eval', re: /\beval\s*\(|new\s+Function\s*\(/ },
  { id: 'commonjs_require', re: /\brequire\s*\(/ },
  { id: 'filesystem', re: new RegExp(`${Q}${NODE}fs(?:/promises)?${Q}`) },
  { id: 'network', re: new RegExp(`${Q}${NODE}(?:net|http|https|http2|dgram|tls|dns)${Q}`) },
  { id: 'child_process', re: new RegExp(`${Q}${NODE}child_process${Q}`) },
];

/**
 * F1 lab-side gate: self-contained/ambient-authority scan over the assembled bundle's source.
 * The F2-critical check — rejects untrusted LLM-authored code reaching for ambient authority.
 *
 * TODO(sdk-0.7): add the SDK 017 manifest gate (`validate` from `@trading-platform/sdk/validation`)
 * once lab bumps `@trading-platform/sdk` to >=0.7.x (0.5.0 does not export `./validation`). The
 * backtester acceptance-gate validates the manifest/contract downstream in the meantime.
 */
export function validateStrategyBundle(a: AssembledStrategyBundle): ValidationVerdict {
  const violations = AMBIENT_PATTERNS.filter((p) => p.re.test(a.source)).map((p) => p.id);
  if (violations.length > 0) {
    return { status: 'rejected', reason: 'forbidden_ambient_authority', violations };
  }
  return { status: 'valid' };
}
