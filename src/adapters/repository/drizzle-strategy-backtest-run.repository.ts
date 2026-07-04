// src/adapters/repository/drizzle-strategy-backtest-run.repository.ts
import { eq, and } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { strategyBacktestRun } from '../../db/schema.ts';
import type { StrategyBacktestRun, StrategyBacktestCompletion } from '../../domain/strategy-backtest-run.ts';
import type { StrategyBacktestRunRepository } from '../../ports/strategy-backtest-run.repository.ts';

type Row = typeof strategyBacktestRun.$inferSelect;

function toDomain(row: Row): StrategyBacktestRun {
  return {
    id: row.id, strategyProfileId: row.strategyProfileId, strategyBundleId: row.strategyBundleId, bundleHash: row.bundleHash,
    paramsHash: row.paramsHash, runKind: row.runKind, platformRunId: row.platformRunId, correlationId: row.correlationId,
    ...(row.taskId !== null ? { taskId: row.taskId } : {}),
    ...(row.resumeToken !== null ? { resumeToken: row.resumeToken } : {}),
    params: row.params, status: row.status, metrics: row.metrics ?? null, platformRun: row.platformRun ?? null,
    artifactRefs: row.artifactRefs, platformContractVersion: row.platformContractVersion, sdkContractVersion: row.sdkContractVersion,
    backend: row.backend, submittedAt: row.submittedAt.toISOString(), finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

export class DrizzleStrategyBacktestRunRepository implements StrategyBacktestRunRepository {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  async createSubmitted(run: StrategyBacktestRun): Promise<void> {
    await this.db.insert(strategyBacktestRun).values({
      id: run.id, strategyProfileId: run.strategyProfileId, strategyBundleId: run.strategyBundleId, bundleHash: run.bundleHash,
      paramsHash: run.paramsHash, runKind: run.runKind, platformRunId: run.platformRunId, correlationId: run.correlationId,
      taskId: run.taskId ?? null, resumeToken: run.resumeToken ?? null, params: run.params, status: run.status,
      metrics: run.metrics, platformRun: run.platformRun, artifactRefs: run.artifactRefs,
      platformContractVersion: run.platformContractVersion, sdkContractVersion: run.sdkContractVersion, backend: run.backend,
      submittedAt: new Date(run.submittedAt), createdAt: new Date(run.createdAt), updatedAt: new Date(run.updatedAt),
    });
  }

  async markCompleted(id: string, c: StrategyBacktestCompletion): Promise<void> {
    await this.db.update(strategyBacktestRun).set({
      status: 'completed', metrics: c.metrics, artifactRefs: c.artifactRefs,
      platformContractVersion: c.platformContractVersion, finishedAt: new Date(c.finishedAt), updatedAt: new Date(c.finishedAt),
    }).where(eq(strategyBacktestRun.id, id));
  }

  async markRejected(id: string): Promise<void> { await this.db.update(strategyBacktestRun).set({ status: 'rejected', finishedAt: new Date(), updatedAt: new Date() }).where(eq(strategyBacktestRun.id, id)); }
  async markFailed(id: string): Promise<void> { await this.db.update(strategyBacktestRun).set({ status: 'failed', finishedAt: new Date(), updatedAt: new Date() }).where(eq(strategyBacktestRun.id, id)); }

  async findById(id: string): Promise<StrategyBacktestRun | null> {
    const rows = await this.db.select().from(strategyBacktestRun).where(eq(strategyBacktestRun.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async findByPlatformRunId(platformRunId: string): Promise<StrategyBacktestRun | null> {
    const rows = await this.db.select().from(strategyBacktestRun).where(eq(strategyBacktestRun.platformRunId, platformRunId)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async findByIdentity(strategyBundleId: string, paramsHash: string, bundleHash: string): Promise<StrategyBacktestRun | null> {
    const rows = await this.db.select().from(strategyBacktestRun)
      .where(and(eq(strategyBacktestRun.strategyBundleId, strategyBundleId), eq(strategyBacktestRun.paramsHash, paramsHash), eq(strategyBacktestRun.bundleHash, bundleHash)))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }
  findByBundleAndParams(strategyBundleId: string, paramsHash: string, bundleHash: string): Promise<StrategyBacktestRun | null> {
    return this.findByIdentity(strategyBundleId, paramsHash, bundleHash);
  }
}
