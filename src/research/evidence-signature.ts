import { verify as cryptoVerify, createPublicKey } from 'node:crypto';
import { canonicalizeEvidenceBody } from './evidence-canonical.ts';

export type TrustedSigners = Readonly<Record<string, string>>; // keyId -> SPKI PEM

// Verifies an Ed25519 signature over the canonical form of `artifact.body` (which INCLUDES its
// own `keyId` field). The PEM is looked up by `body.keyId` in `trustedSigners`. Never throws:
// returns false on unknown keyId, bad signature, or any crypto exception.
export function verifyEvidenceSignature(
  artifact: { body: unknown; signature: string },
  trustedSigners: TrustedSigners,
): boolean {
  const keyId = (artifact.body as { keyId?: string } | null)?.keyId;
  const pem = keyId && Object.hasOwn(trustedSigners, keyId) ? trustedSigners[keyId] : undefined;
  if (!pem) return false;
  try {
    return cryptoVerify(
      null,
      Buffer.from(canonicalizeEvidenceBody(artifact.body), 'utf8'),
      createPublicKey(pem),
      Buffer.from(artifact.signature, 'base64'),
    );
  } catch {
    return false;
  }
}
