// src/domain/backtest-run.ts
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';

export type BacktestRunStatus = 'queued' | 'submitted' | 'running' | 'completed' | 'rejected' | 'failed' | 'evaluated';

export interface BacktestRun {
  id: string;
  hypothesisBuildId: string;
  hypothesisId: string;
  strategyProfileId: string;
  platformRunId: string;
  correlationId: string;
  params: Record<string, unknown>;
  paramsHash: string;
  bundleHash: string;
  status: BacktestRunStatus;
  baselineModuleId: string;
  variantModuleId: string;
  metrics: BacktestMetricBlock | null;          // variant
  baselineMetrics: BacktestMetricBlock | null;
  deltaNetPnlUsd: number | null;
  deltaMaxDrawdownPct: number | null;
  isFragile: boolean | null;
  artifactRefs: string[];                        // opaque platform refs (SP-4)
  platformContractVersion: string;
  sdkContractVersion: string;
  submittedAt: string;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BacktestCompletion {
  metrics: BacktestMetricBlock;
  baselineMetrics: BacktestMetricBlock;
  deltaNetPnlUsd: number;
  deltaMaxDrawdownPct: number;
  isFragile: boolean;
  artifactRefs: string[];
  platformContractVersion: string;
  finishedAt: string;
}
