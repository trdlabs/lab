import type { createModuleManifest } from '@trdlabs/backtester-sdk/builder';

export type BundleManifest = ReturnType<typeof createModuleManifest>;

export interface SignedBacktestEvidence {
  body: {
    schema: 'backtest-evidence/v1';
    backtesterRunId: string;
    bundleHash: string;
    verdict: 'passed' | 'failed';
    datasetRef: string;
    window: { fromMs: number; toMs: number };
    symbols: string[];
    timeframe: string;
    keyId: string;
  };
  signature: string;
}

export interface StrategyRunSubmission {
  bundleBytes: Uint8Array;
  bundleHash: string;
  manifest: BundleManifest;
  curatedBundleHash: string;
  scope: {
    datasetRef: string;
    window: { fromMs: number; toMs: number };
    symbols: string[];
    timeframe: string;
  };
}

export interface StrategyRunResult {
  status: 'signed' | 'equivalent' | 'divergent' | 'rejected' | 'unavailable';
  resultHash?: string;
  evidence?: SignedBacktestEvidence;
  divergence?: { bar: number; field: string; expected: unknown; actual: unknown };
}

export interface BacktesterStrategyPort {
  submitStrategyRun(s: StrategyRunSubmission): Promise<StrategyRunResult>;
}
