import type { BacktestRunStatus } from './backtest-run.ts';
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';
import type { PlatformRunConfig, RunAdmissionEvidence } from '../ports/research-platform.port.ts';

export const STRATEGY_RUN_KIND = 'strategy_baseline' as const;
export const REVISION_COMBO_RUN_KIND = 'revision_combo' as const;
export type StrategyRunKind = typeof STRATEGY_RUN_KIND | typeof REVISION_COMBO_RUN_KIND;

export interface StrategyBacktestRun {
  id: string;
  strategyProfileId: string;
  strategyBundleId: string;          // the strategy bundle's own manifest module id (identity anchor)
  bundleHash: string;
  paramsHash: string;
  runKind: StrategyRunKind;
  platformRunId: string;
  correlationId: string;
  taskId?: string;
  resumeToken?: string;
  params: Record<string, unknown>;
  status: BacktestRunStatus;
  metrics: BacktestMetricBlock | null;   // absolute strategy metrics; null until completed
  platformRun: PlatformRunConfig | null;   // ЗАПРОШЕННОЕ, как отправлено
  /** Д3 3.3в — чем прогон был допущен; `null` = допуска не было. См. `BacktestRun.admission`. */
  admission: RunAdmissionEvidence | null;
  artifactRefs: string[];
  platformContractVersion: string;
  sdkContractVersion: string;
  backend: 'research_platform';
  submittedAt: string;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StrategyBacktestCompletion {
  /** Д3 3.3в: пишется АТОМАРНО с завершением, а не при submit. */
  admission?: RunAdmissionEvidence;
  metrics: BacktestMetricBlock;
  artifactRefs: string[];
  platformContractVersion: string;
  finishedAt: string;
}
