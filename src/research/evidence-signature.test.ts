import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign, createHash } from 'node:crypto';
import { canonicalizeEvidenceBody } from './evidence-canonical.ts';
import { verifyEvidenceSignature, type TrustedSigners } from './evidence-signature.ts';

function makeSigner() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const keyId = 'bt-ed25519-' + createHash('sha256').update(der).digest('hex').slice(0, 16);
  const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const signBody = (body: unknown): string =>
    cryptoSign(null, Buffer.from(canonicalizeEvidenceBody(body), 'utf8'), privateKey).toString('base64');
  return { keyId, pem, signBody };
}

describe('canonicalizeEvidenceBody', () => {
  it('sorts object keys, preserves array order, no trailing newline', () => {
    expect(canonicalizeEvidenceBody({ b: 1, a: [3, 1, 2] })).toBe('{"a":[3,1,2],"b":1}');
  });
});

describe('verifyEvidenceSignature', () => {
  it('accepts a genuine signature over the canonical body', () => {
    const s = makeSigner();
    const body = { schema: 'backtest-evidence/v1', keyId: s.keyId, verdict: 'passed', symbols: ['A', 'B'] };
    const artifact = { body, signature: s.signBody(body) };
    expect(verifyEvidenceSignature(artifact, { [s.keyId]: s.pem })).toBe(true);
  });
  it('rejects a tampered body (single byte changed)', () => {
    const s = makeSigner();
    const body = { schema: 'backtest-evidence/v1', keyId: s.keyId, verdict: 'passed' };
    const artifact = { body: { ...body, verdict: 'failed' }, signature: s.signBody(body) };
    expect(verifyEvidenceSignature(artifact, { [s.keyId]: s.pem })).toBe(false);
  });
  it('rejects an unknown keyId (empty/missing trusted signer)', () => {
    const s = makeSigner();
    const body = { keyId: s.keyId };
    expect(verifyEvidenceSignature({ body, signature: s.signBody(body) }, {})).toBe(false);
  });

  describe('malformed inputs (hardening)', () => {
    it('returns false without throwing on malformed PEM string in trustedSigners', () => {
      const s = makeSigner();
      const body = { keyId: s.keyId, verdict: 'passed' };
      const artifact = { body, signature: s.signBody(body) };
      // Malformed PEM for the trusted signer
      const malformedTrustedSigners: TrustedSigners = { [s.keyId]: 'not-a-pem' };
      expect(() => verifyEvidenceSignature(artifact, malformedTrustedSigners)).not.toThrow();
      expect(verifyEvidenceSignature(artifact, malformedTrustedSigners)).toBe(false);
    });
    it('returns false without throwing on garbage base64 signature', () => {
      const s = makeSigner();
      const body = { keyId: s.keyId, verdict: 'passed' };
      const artifact = { body, signature: 'notbase64!!!' };
      expect(() => verifyEvidenceSignature(artifact, { [s.keyId]: s.pem })).not.toThrow();
      expect(verifyEvidenceSignature(artifact, { [s.keyId]: s.pem })).toBe(false);
    });
    it('returns false without throwing on truncated signature', () => {
      const s = makeSigner();
      const body = { keyId: s.keyId, verdict: 'passed' };
      const validSig = s.signBody(body);
      const truncatedSig = validSig.slice(0, 20); // Truncate to invalid length
      const artifact = { body, signature: truncatedSig };
      expect(() => verifyEvidenceSignature(artifact, { [s.keyId]: s.pem })).not.toThrow();
      expect(verifyEvidenceSignature(artifact, { [s.keyId]: s.pem })).toBe(false);
    });
    it('returns false without throwing on prototype-chain keyId (constructor) with empty trustedSigners', () => {
      const body = { keyId: 'constructor', verdict: 'passed' };
      const artifact = { body, signature: 'anysignature' };
      const emptyTrustedSigners: TrustedSigners = {};
      expect(() => verifyEvidenceSignature(artifact, emptyTrustedSigners)).not.toThrow();
      expect(verifyEvidenceSignature(artifact, emptyTrustedSigners)).toBe(false);
    });
  });
});
