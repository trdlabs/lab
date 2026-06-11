// src/adapters/repository/drizzle-backtest-run.repository.ts
import { eq, and } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { backtestRun } from '../../db/schema.ts';
import type { BacktestRun, BacktestRunStatus, BacktestCompletion } from '../../domain/backtest-run.ts';
import type { BacktestMetricBlock } from '../../ports/platform-gateway.port.ts';
import type { BacktestRunRepository } from '../../ports/backtest-run.repository.ts';

type Row = typeof backtestRun.$inferSelect;

function metricsFromRow(row: Row): BacktestMetricBlock | null {
  if (row.netPnlUsd === null) return null;
  return {
    netPnlUsd: row.netPnlUsd, netPnlPct: row.netPnlPct!, totalTrades: row.totalTrades!, winRate: row.winRate!,
    profitFactor: row.profitFactor!, maxDrawdownPct: row.maxDrawdownPct!, expectancyUsd: row.expectancyUsd!,
    sharpe: row.sharpe!, topTradeContributionPct: row.topTradeContributionPct!,
  };
}

function toDomain(row: Row): BacktestRun {
  return {
    id: row.id, hypothesisBuildId: row.hypothesisBuildId, hypothesisId: row.hypothesisId, strategyProfileId: row.strategyProfileId,
    platformRunId: row.platformRunId, correlationId: row.correlationId, params: row.params, paramsHash: row.paramsHash, bundleHash: row.bundleHash,
    status: row.status as BacktestRunStatus, baselineModuleId: row.baselineModuleId, variantModuleId: row.variantModuleId,
    metrics: metricsFromRow(row), baselineMetrics: (row.baselineMetrics as BacktestMetricBlock | null) ?? null,
    deltaNetPnlUsd: row.deltaNetPnlUsd, deltaMaxDrawdownPct: row.deltaMaxDrawdownPct, isFragile: row.isFragile,
    artifactRefs: row.artifactRefs, platformContractVersion: row.platformContractVersion, sdkContractVersion: row.sdkContractVersion,
    submittedAt: row.submittedAt.toISOString(), finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

export class DrizzleBacktestRunRepository implements BacktestRunRepository {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  async createSubmitted(run: BacktestRun): Promise<void> {
    await this.db.insert(backtestRun).values({
      id: run.id, hypothesisBuildId: run.hypothesisBuildId, hypothesisId: run.hypothesisId, strategyProfileId: run.strategyProfileId,
      platformRunId: run.platformRunId, correlationId: run.correlationId, params: run.params, paramsHash: run.paramsHash, bundleHash: run.bundleHash,
      status: run.status, baselineModuleId: run.baselineModuleId, variantModuleId: run.variantModuleId,
      artifactRefs: run.artifactRefs, platformContractVersion: run.platformContractVersion, sdkContractVersion: run.sdkContractVersion,
      submittedAt: new Date(run.submittedAt), createdAt: new Date(run.createdAt), updatedAt: new Date(run.updatedAt),
    });
  }

  async markCompleted(id: string, c: BacktestCompletion): Promise<void> {
    await this.db.update(backtestRun).set({
      status: 'completed', netPnlUsd: c.metrics.netPnlUsd, netPnlPct: c.metrics.netPnlPct, totalTrades: c.metrics.totalTrades,
      winRate: c.metrics.winRate, profitFactor: c.metrics.profitFactor, maxDrawdownPct: c.metrics.maxDrawdownPct,
      expectancyUsd: c.metrics.expectancyUsd, sharpe: c.metrics.sharpe, topTradeContributionPct: c.metrics.topTradeContributionPct,
      isFragile: c.isFragile, baselineMetrics: c.baselineMetrics, deltaNetPnlUsd: c.deltaNetPnlUsd, deltaMaxDrawdownPct: c.deltaMaxDrawdownPct,
      artifactRefs: c.artifactRefs, platformContractVersion: c.platformContractVersion, finishedAt: new Date(c.finishedAt), updatedAt: new Date(),
    }).where(eq(backtestRun.id, id));
  }

  async markRejected(id: string): Promise<void> { await this.db.update(backtestRun).set({ status: 'rejected', finishedAt: new Date(), updatedAt: new Date() }).where(eq(backtestRun.id, id)); }
  async markFailed(id: string): Promise<void> { await this.db.update(backtestRun).set({ status: 'failed', finishedAt: new Date(), updatedAt: new Date() }).where(eq(backtestRun.id, id)); }
  async markEvaluated(id: string): Promise<void> { await this.db.update(backtestRun).set({ status: 'evaluated', updatedAt: new Date() }).where(eq(backtestRun.id, id)); }

  async findById(id: string): Promise<BacktestRun | null> {
    const rows = await this.db.select().from(backtestRun).where(eq(backtestRun.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async findByIdentity(hypothesisId: string, paramsHash: string, bundleHash: string): Promise<BacktestRun | null> {
    const rows = await this.db.select().from(backtestRun)
      .where(and(eq(backtestRun.hypothesisId, hypothesisId), eq(backtestRun.paramsHash, paramsHash), eq(backtestRun.bundleHash, bundleHash)))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async listByHypothesis(hypothesisId: string): Promise<BacktestRun[]> {
    const rows = await this.db.select().from(backtestRun).where(eq(backtestRun.hypothesisId, hypothesisId));
    return rows.map(toDomain);
  }
}
