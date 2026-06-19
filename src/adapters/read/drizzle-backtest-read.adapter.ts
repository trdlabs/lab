import { eq, and, or, lt, desc, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { backtestRun } from '../../db/schema.ts';
import type { BacktestRun, BacktestRunStatus } from '../../domain/backtest-run.ts';
import type { BacktestMetricBlock } from '../../ports/platform-gateway.port.ts';
import type { BacktestReadPort, BacktestListQuery } from '../../ports/backtest-read.port.ts';

type Row = typeof backtestRun.$inferSelect;

// Own row→domain mapping inside the read boundary (do NOT import the write adapter — import guard).
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
    backend: row.backend as 'sp4_mock' | 'research_platform', resumeToken: row.resumeToken,
    platformRun: (row.platformRun as import('../../ports/research-platform.port.ts').PlatformRunConfig | null) ?? null,
    metrics: metricsFromRow(row), baselineMetrics: (row.baselineMetrics as BacktestMetricBlock | null) ?? null,
    deltaNetPnlUsd: row.deltaNetPnlUsd, deltaMaxDrawdownPct: row.deltaMaxDrawdownPct, isFragile: row.isFragile,
    artifactRefs: row.artifactRefs, platformContractVersion: row.platformContractVersion, sdkContractVersion: row.sdkContractVersion,
    submittedAt: row.submittedAt.toISOString(), finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

export class DrizzleBacktestReadAdapter implements BacktestReadPort {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async list(q: BacktestListQuery): Promise<BacktestRun[]> {
    const conds: SQL[] = [];
    if (q.hypothesisId) conds.push(eq(backtestRun.hypothesisId, q.hypothesisId));
    if (q.status) conds.push(eq(backtestRun.status, q.status));
    if (q.after) {
      const d = new Date(q.after.t);
      conds.push(or(lt(backtestRun.createdAt, d), and(eq(backtestRun.createdAt, d), lt(backtestRun.id, q.after.id)))!);
    }
    const rows = await this.db.select().from(backtestRun)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(backtestRun.createdAt), desc(backtestRun.id))
      .limit(q.limit);
    return rows.map(toDomain);
  }

  async getById(id: string): Promise<BacktestRun | null> {
    const rows = await this.db.select().from(backtestRun).where(eq(backtestRun.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }
}
