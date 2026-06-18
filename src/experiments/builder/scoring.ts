import type { BuilderOutput } from '../../ports/builder.port.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';
import type { CheckResult, ScoreResult } from './types.ts';

const DEFAULT_THRESHOLD = 0.7;

/** Patterns that must never appear in generated overlay source */
const FORBIDDEN_PATTERNS: RegExp[] = [
  /process\.env/,
  /\beval\s*\(/,
  /\bfetch\s*\(/,
  /\brequire\s*\(/,
  /\bexecSync\b/,
  /\bspawn\s*\(/,
  /\bsetInterval\b|\bsetTimeout\b/,
  /new\s+Function\s*\(/,
];

function check(id: string, weight: number, passed: boolean, evidence: string[]): CheckResult {
  return { id, weight, contribution: passed ? weight : 0, evidence };
}

function entrySource(output: BuilderOutput): string {
  const entry = output.manifest.entry;
  return output.files[entry] ?? '';
}

/**
 * Deterministic scorer for BuilderOutput.
 * No LLM calls. Checks structural correctness, safety, and hypothesis alignment.
 */
export function scoreBuilderOutput(
  output: BuilderOutput,
  hypothesis: HypothesisProposal,
  threshold = DEFAULT_THRESHOLD,
): ScoreResult {
  const src = entrySource(output);
  const srcLower = src.toLowerCase();
  const checks: CheckResult[] = [];

  // 1. Entry file exists in files map
  checks.push(check(
    'entry_file_present',
    0.15,
    src.length > 0,
    src.length > 0 ? ['entry file found'] : [`missing file "${output.manifest.entry}" in files map`],
  ));

  // 2. overlay export present
  const hasOverlayExport = /export\s+(const|let|var)\s+overlay\b/.test(src);
  checks.push(check(
    'overlay_export',
    0.25,
    hasOverlayExport,
    hasOverlayExport ? ['`export const overlay` found'] : ['no `export const overlay` in entry file'],
  ));

  // 3. No forbidden patterns
  const violations = FORBIDDEN_PATTERNS.filter((p) => p.test(src)).map((p) => p.source);
  checks.push(check(
    'no_forbidden_patterns',
    0.20,
    violations.length === 0,
    violations.length === 0 ? ['no forbidden patterns'] : violations.map((v) => `forbidden: ${v}`),
  ));

  // 4. Manifest entry === 'index.ts'
  const manifestEntryOk = output.manifest.entry === 'index.ts';
  checks.push(check(
    'manifest_entry_index',
    0.10,
    manifestEntryOk,
    manifestEntryOk ? ['manifest.entry = "index.ts"'] : [`manifest.entry = "${output.manifest.entry}" (expected "index.ts")`],
  ));

  // 5. manifest.exports includes 'overlay'
  const exportsOverlay = output.manifest.exports.includes('overlay');
  checks.push(check(
    'manifest_exports_overlay',
    0.10,
    exportsOverlay,
    exportsOverlay ? ['manifest.exports includes "overlay"'] : [`manifest.exports = [${output.manifest.exports.join(',')}]`],
  ));

  // 6. appliesTo matches hypothesis
  const appliesToOk = output.manifest.appliesTo === hypothesis.ruleAction.appliesTo;
  checks.push(check(
    'applies_to_matches',
    0.10,
    appliesToOk,
    appliesToOk
      ? [`appliesTo="${output.manifest.appliesTo}" matches hypothesis`]
      : [`appliesTo mismatch: got "${output.manifest.appliesTo}", expected "${hypothesis.ruleAction.appliesTo}"`],
  ));

  // 7. overlay has non-trivial body: either data-driven rules[] OR functional overlay
  const hasDataRules = /rules\s*:\s*\[/.test(src) && !/rules\s*:\s*\[\s*\]/.test(src);
  const hasFunctionalOverlay = /export\s+const\s+overlay\s*=\s*(function|\()/.test(src);
  const hasNonTrivialBody = hasDataRules || hasFunctionalOverlay;
  checks.push(check(
    'overlay_has_rules',
    0.10,
    hasNonTrivialBody,
    hasNonTrivialBody
      ? [hasDataRules ? 'data-driven rules array present' : 'functional overlay body detected']
      : ['overlay.rules appears empty or missing and no functional body detected'],
  ));

  const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
  const totalContribution = checks.reduce((s, c) => s + c.contribution, 0);
  const score = totalWeight > 0 ? totalContribution / totalWeight : 0;

  // no_forbidden_patterns is a hard gate: any violation → FAIL regardless of total score
  const hasForbiddenViolation = checks.find((c) => c.id === 'no_forbidden_patterns')?.contribution === 0
    && (checks.find((c) => c.id === 'no_forbidden_patterns')?.evidence.some((e) => e.startsWith('forbidden:')) ?? false);

  return {
    score,
    verdict: hasForbiddenViolation ? 'FAIL' : score >= threshold ? 'PASS' : 'FAIL',
    threshold,
    checks,
  };
}
