// src/validation/build-validator.ts
import { assembleBundle, ModuleManifestSchema, SDK_CONTRACT_VERSION, type ModuleBundle } from '../domain/module-bundle.ts';
import type { ValidationIssue } from '../domain/schemas.ts';

export interface BuildValidation {
  status: 'built' | 'build_failed';
  issues: ValidationIssue[];
}

/** Non-authoritative fast-fail scan (the platform sandbox 019 is the real boundary).
 *  Builtins are matched on import / dynamic-import / require SPECIFIERS only — NOT a whole-file
 *  substring scan — so 'fs' inside 'offset' or a bare 'https' key never false-positives.
 *  The global-ish tokens below stay a text scan. */
export const RESTRICTED_MODULE_SPECIFIERS = [
  'fs', 'node:fs', 'child_process', 'node:child_process', 'net', 'node:net',
  'http', 'node:http', 'https', 'node:https',
];
export const RESTRICTED_CODE_TOKENS = ['process.env', 'eval', 'new Function', 'fetch', 'WebSocket'];
const RESTRICTED_MODULE_SET = new Set<string>(RESTRICTED_MODULE_SPECIFIERS);

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function validateBundle(
  bundle: ModuleBundle,
  ctx: { allowedImports: Set<string>; allowedCapabilities: Set<string> },
): BuildValidation {
  const issues: ValidationIssue[] = [];
  const m = bundle.manifest;

  const parsed = ModuleManifestSchema.safeParse(m);
  if (!parsed.success) {
    issues.push({ code: 'manifest_invalid', severity: 'error', path: 'manifest', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
  }
  if (m.moduleKind !== 'hypothesis_overlay') {
    issues.push({ code: 'disallowed_module_kind', severity: 'error', path: 'manifest.moduleKind', message: `moduleKind '${m.moduleKind}' is not allowed` });
  }

  const entrySource = bundle.files[m.entry];
  if (entrySource === undefined) {
    issues.push({ code: 'missing_entry', severity: 'error', path: 'manifest.entry', message: `entry file '${m.entry}' not present in bundle files` });
  } else {
    m.exports.forEach((exp, i) => {
      if (!entrySource.includes(exp)) {
        issues.push({ code: 'missing_export', severity: 'error', path: `manifest.exports.${i}`, message: `export '${exp}' not found in entry source` });
      }
    });
  }

  for (const [path, source] of Object.entries(bundle.files)) {
    const tokenHits = RESTRICTED_CODE_TOKENS.filter((t) => source.includes(t));
    if (tokenHits.length > 0) {
      issues.push({ code: 'restricted_import', severity: 'error', path: `files.${path}`, message: `restricted code tokens: ${tokenHits.join(', ')}` });
    }
    // Builtins + allowlist are matched on module SPECIFIERS only (import / dynamic import / require).
    const re = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]([^'"]+)['"]/g;
    let mt: RegExpExecArray | null;
    while ((mt = re.exec(source)) !== null) {
      const spec = mt[1]!;
      if (RESTRICTED_MODULE_SET.has(spec)) {
        issues.push({ code: 'restricted_import', severity: 'error', path: `files.${path}`, message: `restricted module import: ${spec}` });
      } else if (!ctx.allowedImports.has(spec)) {
        issues.push({ code: 'restricted_import', severity: 'error', path: `files.${path}`, message: `import not allowed: ${spec}` });
      }
    }
  }

  m.capabilities.forEach((cap, i) => {
    if (!ctx.allowedCapabilities.has(cap)) {
      issues.push({ code: 'capability_violation', severity: 'error', path: `manifest.capabilities.${i}`, message: `capability '${cap}' is not allowed` });
    }
  });

  const recomputed = assembleBundle(m, bundle.files).bundleHash;
  if (recomputed !== bundle.bundleHash) {
    issues.push({ code: 'bundle_hash_mismatch', severity: 'error', path: 'bundleHash', message: 'bundleHash does not match content' });
  }
  if (m.sdkContractVersion !== SDK_CONTRACT_VERSION) {
    issues.push({ code: 'sdk_contract_mismatch', severity: 'error', path: 'manifest.sdkContractVersion', message: `expected ${SDK_CONTRACT_VERSION}, got ${m.sdkContractVersion}` });
  }

  issues.sort((a, b) => compareStrings(a.path, b.path) || compareStrings(a.code, b.code));
  const status = issues.some((i) => i.severity === 'error') ? 'build_failed' : 'built';
  return { status, issues };
}
