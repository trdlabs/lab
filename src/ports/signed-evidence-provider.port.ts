import type { SignedBacktestEvidence } from './backtester-strategy.port.ts';

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
  provide(args: SignedEvidenceProvideArgs): Promise<SignedBacktestEvidence | null>;
}
