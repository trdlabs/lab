// Lab-side pre-flight admission mirror of the platform's fail-closed evidence matrix.
// Ladder is FIRST-MATCH: signature -> verdict -> bundle-hash pin -> scope. Pure (no I/O).
import { verifyEvidenceSignature, type TrustedSigners } from './evidence-signature.ts';
import type { SignedBacktestEvidence } from '../ports/backtester-strategy.port.ts';

export interface EvidenceCheckScope {
  bundleHash: string;
  datasetRef: string;
  window: { fromMs: number; toMs: number };
  symbols: string[];
  timeframe: string;
}

export type EvidenceVerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'evidence_signature_invalid'
        | 'backtest_not_passed'
        | 'bundle_hash_mismatch'
        | 'scope_mismatch';
    };

export function verifySignedEvidence(
  evidence: SignedBacktestEvidence,
  expected: EvidenceCheckScope,
  trustedSigners: TrustedSigners,
): EvidenceVerifyResult {
  if (!verifyEvidenceSignature(evidence, trustedSigners)) {
    return { ok: false, reason: 'evidence_signature_invalid' };
  }

  const { body } = evidence;

  if (body.verdict !== 'passed') {
    return { ok: false, reason: 'backtest_not_passed' };
  }

  if (body.bundleHash !== expected.bundleHash) {
    return { ok: false, reason: 'bundle_hash_mismatch' };
  }

  // Backtester signs SORTED symbols; lab scope is unsorted at the call site, so this MUST be a
  // sort-then-compare, not an order-sensitive array equality.
  const bodySymbolsSorted = [...body.symbols].sort();
  const expectedSymbolsSorted = [...expected.symbols].sort();
  const symbolsMatch =
    bodySymbolsSorted.length === expectedSymbolsSorted.length &&
    bodySymbolsSorted.every((s, i) => s === expectedSymbolsSorted[i]);

  if (
    body.datasetRef !== expected.datasetRef ||
    body.timeframe !== expected.timeframe ||
    body.window.fromMs !== expected.window.fromMs ||
    body.window.toMs !== expected.window.toMs ||
    !symbolsMatch
  ) {
    return { ok: false, reason: 'scope_mismatch' };
  }

  return { ok: true };
}
