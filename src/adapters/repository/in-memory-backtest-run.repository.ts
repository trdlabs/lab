// src/adapters/repository/in-memory-backtest-run.repository.ts
import type { BacktestRun, BacktestCompletion } from '../../domain/backtest-run.ts';
import type { BacktestRunRepository } from '../../ports/backtest-run.repository.ts';

export class InMemoryBacktestRunRepository implements BacktestRunRepository {
  private readonly byId = new Map<string, BacktestRun>();

  async createSubmitted(run: BacktestRun): Promise<void> {
    if (this.byId.has(run.id)) throw new Error(`backtest_run already exists: ${run.id}`);
    // Mirror the DB unique (hypothesis_id, params_hash, bundle_hash) idempotency guard.
    for (const r of this.byId.values()) {
      if (r.hypothesisId === run.hypothesisId && r.paramsHash === run.paramsHash && r.bundleHash === run.bundleHash) {
        throw new Error(`backtest_run already exists for (${run.hypothesisId}, ${run.paramsHash}, ${run.bundleHash})`);
      }
    }
    this.byId.set(run.id, { ...run });
  }

  private patch(id: string, patch: Partial<BacktestRun>): void {
    const row = this.byId.get(id);
    if (!row) throw new Error(`backtest_run not found: ${id}`);
    this.byId.set(id, { ...row, ...patch, updatedAt: new Date().toISOString() });
  }

  async markCompleted(id: string, c: BacktestCompletion): Promise<void> {
    this.patch(id, {
      status: 'completed', metrics: c.metrics, baselineMetrics: c.baselineMetrics,
      deltaNetPnlUsd: c.deltaNetPnlUsd, deltaMaxDrawdownPct: c.deltaMaxDrawdownPct, isFragile: c.isFragile,
      artifactRefs: c.artifactRefs, platformContractVersion: c.platformContractVersion, finishedAt: c.finishedAt,
    });
  }

  async markRejected(id: string): Promise<void> { this.patch(id, { status: 'rejected', finishedAt: new Date().toISOString() }); }
  async markFailed(id: string): Promise<void> { this.patch(id, { status: 'failed', finishedAt: new Date().toISOString() }); }
  async markEvaluated(id: string): Promise<void> { this.patch(id, { status: 'evaluated' }); }

  async findById(id: string): Promise<BacktestRun | null> { return this.byId.get(id) ?? null; }

  async findByIdentity(hypothesisId: string, paramsHash: string, bundleHash: string): Promise<BacktestRun | null> {
    for (const r of this.byId.values()) {
      if (r.hypothesisId === hypothesisId && r.paramsHash === paramsHash && r.bundleHash === bundleHash) return { ...r };
    }
    return null;
  }

  async listResumablePlatformRuns(): Promise<BacktestRun[]> {
    return [...this.byId.values()]
      .filter((r) => r.status === 'submitted' && r.backend === 'research_platform')
      .map((r) => ({ ...r }));
  }

  async listByHypothesis(hypothesisId: string): Promise<BacktestRun[]> {
    return [...this.byId.values()].filter((r) => r.hypothesisId === hypothesisId);
  }
}
