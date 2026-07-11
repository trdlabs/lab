import type { ArtifactRef } from './types.ts';

export type ExperimentType =
  | 'new_strategy_validation'
  | 'paper_improvement'
  | 'walk_forward'
  | 'walk_forward_optimization'
  | 'robustness_suite'
  | 'regression_suite'
  | 'strategy_baseline_validation';

export type ParameterGrid = Record<string, unknown[]>;

export type ExperimentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type MemberRole = 'sanity' | 'train' | 'holdout' | 'targeted' | 'regression';
export type ExperimentVerdict = 'PASS' | 'FAIL' | 'MODIFY' | 'INCONCLUSIVE' | 'PAPER_CANDIDATE';

export interface DatasetScope {
  datasetId: string;
  symbols: string[];
  timeframe: string;
  period: { from: string; to: string }; // ISO
}

export interface HoldoutPolicy {
  mode: 'none' | 'time_based' | 'trade_based';
  minTradesTrain: number;
  minTradesHoldout: number;
  lowConfidenceThreshold: number;
  minHistoryDays: number;
}

export const DEFAULT_HOLDOUT_POLICY: HoldoutPolicy = {
  mode: 'trade_based',
  minTradesTrain: 50,
  minTradesHoldout: 30,
  lowConfidenceThreshold: 15,
  minHistoryDays: 30,
};

export interface HoldoutBoundary {
  mode: 'none' | 'trade_based';
  t?: string; // ISO; the fixed split boundary; absent when mode='none'
  trainTrades?: number;
  holdoutTrades?: number;
  lowConfidence: boolean;
  reason?: 'insufficient_trades' | 'insufficient_history' | 'ok';
}

export interface TradeRecord {
  entryTs: number; // epoch ms
  exitTs: number;
  side: 'long' | 'short';
  realizedPnl: number;
  /** Raw engine close reason as serialized in the trades artifact (e.g. 'end_of_data', 'stop_hit', 'time_exit'); undefined on legacy/fake rows. */
  closeReason?: string;
}

export interface ExperimentFlags {
  lowConfidenceHoldout: boolean;
  overfit: boolean;
  fragility: string[];
  coverageWarnings: string[];
}

export interface MemberResultSummary {
  decision?: ExperimentVerdict;
  totalTrades?: number;
  netPnlUsd?: number;
  maxDrawdownPct?: number;
  sharpe?: number;
}

export interface ResearchExperiment {
  id: string;
  experimentKey: string;
  experimentType: ExperimentType;
  strategyProfileId: string;
  hypothesisId?: string;
  buildId?: string;
  bundleHash?: string;
  bundleArtifactRef?: ArtifactRef;
  parameterGrid?: ParameterGrid;
  objective?: string;
  datasetScope: DatasetScope;
  holdoutPolicy: HoldoutPolicy;
  holdoutBoundary?: HoldoutBoundary;
  status: ExperimentStatus;
  verdict?: ExperimentVerdict;
  verdictReason?: string;
  aggregateMetrics?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ExperimentRunMember {
  id: string;
  experimentId: string;
  backtestRunId?: string;
  strategyBacktestRunId?: string;
  role: MemberRole;
  foldId?: number;
  periodFrom: string;
  periodTo: string;
  symbols: string[];
  paramsHash: string;
  params?: Record<string, unknown>;
  oos?: boolean;
  bundleHash: string;
  tradeCount?: number;
  resultSummary?: MemberResultSummary;
  createdAt: string;
}

export interface ExperimentEvaluation {
  id: string;
  experimentId: string;
  evaluatorVersion: string;
  rawScores: Record<string, unknown>;
  flags: ExperimentFlags;
  verdict: ExperimentVerdict;
  verdictReason?: string;
  createdAt: string;
}
