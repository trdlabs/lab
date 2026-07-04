import type { SignedBacktestEvidence } from './backtester-strategy.port.ts';
import type { TrustedSigners } from '../research/evidence-signature.ts';

export interface SignedEvidenceProvideArgs {
  backtesterRunId: string;
  bundleHash: string;
  datasetRef: string;
  window: { from: string; to: string };
  symbols: string[];
  timeframe: string;
}

export interface SignedEvidenceProviderPort {
  readonly available: boolean;
  /**
   * Trusted signer keys (keyId -> SPKI PEM) whose evidence THIS provider vouches for — a
   * self-signing provider (the fixture) must surface its own public key here so the verifier
   * accepts what it produces. Composition merges these into the effective `trustedSigners`.
   * Undefined for `none`/`http`, whose trust anchor is env `LAB_TRUSTED_SIGNERS_JSON`.
   */
  readonly trustedSigners?: TrustedSigners;
  provide(args: SignedEvidenceProvideArgs): Promise<SignedBacktestEvidence | null>;
}
