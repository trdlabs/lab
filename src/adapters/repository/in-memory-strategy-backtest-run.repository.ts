import type { StrategyBacktestRunRepository } from '../../ports/strategy-backtest-run.repository.ts';
import type { StrategyBacktestRun, StrategyBacktestCompletion } from '../../domain/strategy-backtest-run.ts';

export class InMemoryStrategyBacktestRunRepository implements StrategyBacktestRunRepository {
  private readonly rows = new Map<string, StrategyBacktestRun>();
  async createSubmitted(run: StrategyBacktestRun): Promise<void> { this.rows.set(run.id, { ...run }); }
  async markCompleted(id: string, c: StrategyBacktestCompletion): Promise<void> {
    const r = this.rows.get(id); if (!r) return;
    this.rows.set(id, { ...r, status: 'completed', metrics: c.metrics, artifactRefs: [...c.artifactRefs],
      platformContractVersion: c.platformContractVersion, finishedAt: c.finishedAt, updatedAt: c.finishedAt });
  }
  async markRejected(id: string): Promise<void> {
    const r = this.rows.get(id);
    if (r) this.rows.set(id, { ...r, status: 'rejected', finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  async markFailed(id: string): Promise<void> {
    const r = this.rows.get(id);
    if (r) this.rows.set(id, { ...r, status: 'failed', finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  async findById(id: string): Promise<StrategyBacktestRun | null> { return this.rows.get(id) ?? null; }
  async findByPlatformRunId(pid: string): Promise<StrategyBacktestRun | null> {
    for (const r of this.rows.values()) if (r.platformRunId === pid) return r; return null;
  }
  async findByIdentity(bundleId: string, ph: string, bh: string): Promise<StrategyBacktestRun | null> {
    for (const r of this.rows.values()) if (r.strategyBundleId === bundleId && r.paramsHash === ph && r.bundleHash === bh) return r;
    return null;
  }
  findByBundleAndParams(strategyBundleId: string, paramsHash: string, bundleHash: string): Promise<StrategyBacktestRun | null> {
    return this.findByIdentity(strategyBundleId, paramsHash, bundleHash);
  }
}
