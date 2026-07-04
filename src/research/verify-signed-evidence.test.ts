import { describe, it, expect } from 'vitest';
import { buildFixtureSignedEvidence } from './fixture-signed-evidence.ts';
import { verifySignedEvidence, type EvidenceCheckScope } from './verify-signed-evidence.ts';

const baseScope: EvidenceCheckScope = {
  bundleHash: 'hash-abc',
  datasetRef: 'dataset-1',
  window: { fromMs: 1000, toMs: 2000 },
  symbols: ['BTCUSDT', 'ETHUSDT'],
  timeframe: '1h',
};

describe('verifySignedEvidence', () => {
  it('accepts a genuinely-signed, verdict-passed, scope-matching artifact', () => {
    const { evidence, trustedSigners } = buildFixtureSignedEvidence({
      backtesterRunId: 'run-1',
      ...baseScope,
    });
    expect(verifySignedEvidence(evidence, baseScope, trustedSigners)).toEqual({ ok: true });
  });

  it('rejects a tampered artifact (body changed post-signing) as evidence_signature_invalid', () => {
    const { evidence, trustedSigners } = buildFixtureSignedEvidence({
      backtesterRunId: 'run-1',
      ...baseScope,
    });
    const tampered = { ...evidence, body: { ...evidence.body, bundleHash: 'hash-tampered' } };
    expect(verifySignedEvidence(tampered, baseScope, trustedSigners)).toEqual({
      ok: false,
      reason: 'evidence_signature_invalid',
    });
  });

  it('rejects verdict:failed as backtest_not_passed (ahead of scope checks)', () => {
    const { evidence, trustedSigners } = buildFixtureSignedEvidence(
      { backtesterRunId: 'run-1', ...baseScope },
      'failed',
    );
    expect(verifySignedEvidence(evidence, baseScope, trustedSigners)).toEqual({
      ok: false,
      reason: 'backtest_not_passed',
    });
  });

  it('rejects a bundleHash mismatch as bundle_hash_mismatch (ahead of scope checks)', () => {
    const { evidence, trustedSigners } = buildFixtureSignedEvidence({
      backtesterRunId: 'run-1',
      ...baseScope,
    });
    const expected = { ...baseScope, bundleHash: 'hash-different' };
    expect(verifySignedEvidence(evidence, expected, trustedSigners)).toEqual({
      ok: false,
      reason: 'bundle_hash_mismatch',
    });
  });

  it('rejects a datasetRef mismatch as scope_mismatch', () => {
    const { evidence, trustedSigners } = buildFixtureSignedEvidence({
      backtesterRunId: 'run-1',
      ...baseScope,
    });
    const expected = { ...baseScope, datasetRef: 'dataset-other' };
    expect(verifySignedEvidence(evidence, expected, trustedSigners)).toEqual({
      ok: false,
      reason: 'scope_mismatch',
    });
  });

  it('rejects a timeframe mismatch as scope_mismatch', () => {
    const { evidence, trustedSigners } = buildFixtureSignedEvidence({
      backtesterRunId: 'run-1',
      ...baseScope,
    });
    const expected = { ...baseScope, timeframe: '4h' };
    expect(verifySignedEvidence(evidence, expected, trustedSigners)).toEqual({
      ok: false,
      reason: 'scope_mismatch',
    });
  });

  it('rejects a window mismatch as scope_mismatch', () => {
    const { evidence, trustedSigners } = buildFixtureSignedEvidence({
      backtesterRunId: 'run-1',
      ...baseScope,
    });
    const expected = { ...baseScope, window: { fromMs: 999, toMs: 2000 } };
    expect(verifySignedEvidence(evidence, expected, trustedSigners)).toEqual({
      ok: false,
      reason: 'scope_mismatch',
    });
  });

  it('rejects a symbols-set mismatch as scope_mismatch', () => {
    const { evidence, trustedSigners } = buildFixtureSignedEvidence({
      backtesterRunId: 'run-1',
      ...baseScope,
    });
    const expected = { ...baseScope, symbols: ['BTCUSDT', 'SOLUSDT'] };
    expect(verifySignedEvidence(evidence, expected, trustedSigners)).toEqual({
      ok: false,
      reason: 'scope_mismatch',
    });
  });

  it('accepts symbols in a different order but the same set (sort-compare, not order-sensitive)', () => {
    // Fixture builder sorts symbols per the backtester's buildEvidenceBody, so the signed body
    // ends up as ['BTCUSDT','ETHUSDT'] regardless of the order fed into the scope.
    const { evidence, trustedSigners } = buildFixtureSignedEvidence({
      backtesterRunId: 'run-1',
      ...baseScope,
      symbols: ['ETHUSDT', 'BTCUSDT'],
    });
    const expected = { ...baseScope, symbols: ['ETHUSDT', 'BTCUSDT'] };
    expect(verifySignedEvidence(evidence, expected, trustedSigners)).toEqual({ ok: true });
  });

  it('rejects tampering of a signed field NOT in EvidenceCheckScope (backtesterRunId) as evidence_signature_invalid, proving signature gates everything', () => {
    // backtesterRunId is signed in the evidence body but NOT checked by any downstream rung
    // (not in EvidenceCheckScope). This test proves the signature check runs FIRST: if we tamper
    // the backtesterRunId post-signing without re-signing, only the signature check can catch it.
    const { evidence, trustedSigners } = buildFixtureSignedEvidence({
      backtesterRunId: 'run-1',
      ...baseScope,
    });
    const tampered = { ...evidence, body: { ...evidence.body, backtesterRunId: 'run-999' } };
    expect(verifySignedEvidence(tampered, baseScope, trustedSigners)).toEqual({
      ok: false,
      reason: 'evidence_signature_invalid',
    });
  });

  it('rejects a window.toMs-only mismatch as scope_mismatch', () => {
    const { evidence, trustedSigners } = buildFixtureSignedEvidence({
      backtesterRunId: 'run-1',
      ...baseScope,
    });
    const expected = { ...baseScope, window: { fromMs: 1000, toMs: 2500 } };
    expect(verifySignedEvidence(evidence, expected, trustedSigners)).toEqual({
      ok: false,
      reason: 'scope_mismatch',
    });
  });

  it('rejects a symbols-length mismatch (extra symbol in expected) as scope_mismatch', () => {
    const { evidence, trustedSigners } = buildFixtureSignedEvidence({
      backtesterRunId: 'run-1',
      ...baseScope,
    });
    const expected = { ...baseScope, symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] };
    expect(verifySignedEvidence(evidence, expected, trustedSigners)).toEqual({
      ok: false,
      reason: 'scope_mismatch',
    });
  });
});
