import type { AssembledStrategyBundle } from '../domain/strategy-bundle.ts';
import { validate } from '@trading-platform/sdk/validation';
import { platformContractContext } from '@trading-platform/sdk/research-contract';

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
 * Lab-side pre-submit gate. Composite, fail-closed:
 *   1. F1 ambient-authority scan over the assembled bundle's source — rejects untrusted
 *      LLM-authored code reaching for ambient authority (the F2-critical check).
 *   2. SDK-017 manifest-contract `validate()` — the platform-blessed 017 kernel over the
 *      module manifest. `a.manifest` carries a backtester-only `bundleContractVersion`; the 017
 *      schema is `additionalProperties:false`, so that field is stripped before validation.
 * `rejected` is a normal outcome; `throw` is reserved for infra errors.
 */
export function validateStrategyBundle(a: AssembledStrategyBundle): ValidationVerdict {
  const violations = AMBIENT_PATTERNS.filter((p) => p.re.test(a.source)).map((p) => p.id);
  if (violations.length > 0) {
    return { status: 'rejected', reason: 'forbidden_ambient_authority', violations };
  }

  // 017's module-manifest schema is `additionalProperties:false`; strip the backtester-only
  // `bundleContractVersion` before validating. Any future backtester-only manifest field must be
  // added here too (the `clean twin → valid` test is the live tripwire if one slips through).
  const { bundleContractVersion: _bundleContractVersion, ...manifest017 } = a.manifest;
  const result = validate({ inputKind: 'module', manifest: manifest017 }, platformContractContext());
  if (result.status === 'rejected') {
    return {
      status: 'rejected',
      reason: 'manifest_contract_invalid',
      violations: result.issues.filter((i) => i.severity === 'error').map((i) => i.code),
    };
  }

  return { status: 'valid' };
}
