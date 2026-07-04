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
});
