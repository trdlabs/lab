// TEST/DEMO ONLY fixture signer — mirrors the backtester's buildEvidenceBody + Ed25519 signing so
// unit tests can exercise verifySignedEvidence against a genuinely-signed artifact without a live
// backtester. Production evidence always comes from the real backtester.
import { generateKeyPairSync, sign as cryptoSign, createHash } from 'node:crypto';
import { canonicalizeEvidenceBody } from './evidence-canonical.ts';
import type { TrustedSigners } from './evidence-signature.ts';
import type { SignedBacktestEvidence } from '../ports/backtester-strategy.port.ts';
import type { EvidenceCheckScope } from './verify-signed-evidence.ts';

export function buildFixtureSignedEvidence(
  scope: { backtesterRunId: string } & EvidenceCheckScope,
  verdict: 'passed' | 'failed' = 'passed',
): { evidence: SignedBacktestEvidence; trustedSigners: TrustedSigners } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const keyId = 'bt-ed25519-' + createHash('sha256').update(der).digest('hex').slice(0, 16);
  const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

  const body: SignedBacktestEvidence['body'] = {
    schema: 'backtest-evidence/v1',
    backtesterRunId: scope.backtesterRunId,
    bundleHash: scope.bundleHash,
    verdict,
    datasetRef: scope.datasetRef,
    window: { fromMs: scope.window.fromMs, toMs: scope.window.toMs },
    symbols: [...scope.symbols].sort(),
    timeframe: scope.timeframe,
    keyId,
  };

  const signature = cryptoSign(
    null,
    Buffer.from(canonicalizeEvidenceBody(body), 'utf8'),
    privateKey,
  ).toString('base64');

  return { evidence: { body, signature }, trustedSigners: { [keyId]: pem } };
}
