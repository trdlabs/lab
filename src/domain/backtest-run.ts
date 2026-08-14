// src/domain/backtest-run.ts
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';
import type { PlatformRunConfig, RunAdmissionEvidence } from '../ports/research-platform.port.ts';

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
  backend: 'sp4_mock' | 'research_platform';
  taskId?: string;                                // originating ResearchTask.id (research_platform only); enables resume event continuity
  resumeToken: string | null;
  platformRun: PlatformRunConfig | null;       // ЗАПРОШЕННОЕ, как отправлено; допуск его не переписывает
  /**
   * Д3 3.3в — чем прогон был ДОПУЩЕН: effective-период и обе идентичности.
   * Лежит РЯДОМ с `platformRun`, а не вместо него: запрошенное и разрешённое —
   * разные факты, и схлопнув их, нельзя ответить, был ли период сужен.
   *
   * `null` — допуска не было вовсе (мок, фикстура). Это наблюдаемое отличие от
   * «допуск прошёл»; effective отсюда НЕ вычисляется и не подставляется.
   */
  admission: RunAdmissionEvidence | null;
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
  /** Д3 3.3в: пишется АТОМАРНО с завершением, а не при submit — при submit допуск ещё не вынесен. */
  admission?: RunAdmissionEvidence;
  metrics: BacktestMetricBlock;
  baselineMetrics: BacktestMetricBlock;
  deltaNetPnlUsd: number;
  deltaMaxDrawdownPct: number;
  isFragile: boolean;
  artifactRefs: string[];
  platformContractVersion: string;
  finishedAt: string;
}
